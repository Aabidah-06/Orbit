const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

/**
 * Database manager supporting multi-region failover and read-replica routing (#139).
 *
 * Directs mutations to the primary database and routes eligible idempotent reads
 * (such as GET /plans/:id and GET /rates) to healthy read replicas.
 * Keeps read endpoints operational during primary database outages.
 */

const DEFAULT_COOLDOWN_MS = 30000;

class DatabaseManager {
    constructor(options = {}) {
        this.supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
        this.supabaseKey = options.supabaseKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
        this.replicaUrls = options.replicaUrls || this.parseReplicaUrls(process.env.SUPABASE_READ_REPLICA_URLS || process.env.SUPABASE_REPLICA_URL);
        this.replicaKey = options.replicaKey || process.env.SUPABASE_REPLICA_SERVICE_ROLE_KEY || this.supabaseKey;
        this.cooldownMs = options.cooldownMs || Number(process.env.REPLICA_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;

        this.databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
        this.databaseReplicaUrls = options.databaseReplicaUrls || this.parseReplicaUrls(process.env.DATABASE_REPLICA_URLS || process.env.DATABASE_READ_REPLICA_URL);

        // Primary client
        this.primaryClient = null;
        if (this.supabaseUrl && this.supabaseKey) {
            this.primaryClient = createClient(this.supabaseUrl, this.supabaseKey);
        }

        // Replica clients with health tracking
        this.replicas = (this.replicaUrls || []).map((url, index) => ({
            id: `replica-${index}`,
            url,
            client: createClient(url, this.replicaKey),
            isHealthy: true,
            lastFailedAt: null,
            failureCount: 0,
        }));

        this.replicaRoundRobinIndex = 0;
        this.primaryHealthy = true;
        this.primaryLastFailedAt = null;

        // PG connection pools
        this.primaryPool = null;
        this.replicaPools = [];
    }

    parseReplicaUrls(envVal) {
        if (!envVal) return [];
        return envVal
            .split(',')
            .map((u) => u.trim())
            .filter((u) => u.length > 0);
    }

    getPrimaryClient(app) {
        if (app?.locals?.primarySupabase) return app.locals.primarySupabase;
        if (app?.locals?.supabase) return app.locals.supabase;
        return this.primaryClient;
    }

    markPrimaryFailure() {
        this.primaryHealthy = false;
        this.primaryLastFailedAt = Date.now();
    }

    markPrimaryHealthy() {
        this.primaryHealthy = true;
        this.primaryLastFailedAt = null;
    }

    isPrimaryHealthy() {
        if (this.primaryHealthy) return true;
        if (this.primaryLastFailedAt && Date.now() - this.primaryLastFailedAt > this.cooldownMs) {
            this.primaryHealthy = true;
            return true;
        }
        return false;
    }

    getHealthyReplicas() {
        const now = Date.now();
        return this.replicas.map((replica) => {
            if (!replica.isHealthy && replica.lastFailedAt && (now - replica.lastFailedAt > this.cooldownMs)) {
                replica.isHealthy = true;
                replica.failureCount = 0;
            }
            return replica;
        }).filter((replica) => replica.isHealthy);
    }

    markReplicaFailure(replicaClient) {
        const rep = this.replicas.find((r) => r.client === replicaClient);
        if (rep) {
            rep.isHealthy = false;
            rep.lastFailedAt = Date.now();
            rep.failureCount += 1;
        }
    }

    markReplicaHealthy(replicaClient) {
        const rep = this.replicas.find((r) => r.client === replicaClient);
        if (rep) {
            rep.isHealthy = true;
            rep.failureCount = 0;
            rep.lastFailedAt = null;
        }
    }

    getReadClient(app) {
        // Test override takes precedence
        if (app?.locals?.replicaSupabase) return app.locals.replicaSupabase;

        const healthyReplicas = this.getHealthyReplicas();
        if (healthyReplicas.length > 0) {
            const selected = healthyReplicas[this.replicaRoundRobinIndex % healthyReplicas.length];
            this.replicaRoundRobinIndex = (this.replicaRoundRobinIndex + 1) % healthyReplicas.length;
            return selected.client;
        }

        // Fallback to primary client if available and healthy, or if no replicas are configured
        if (app?.locals?.primarySupabase) return app.locals.primarySupabase;
        if (app?.locals?.supabase) return app.locals.supabase;
        return this.primaryClient;
    }

    getReportPool(app, { readOnly = false } = {}) {
        if (readOnly && app?.locals?.reportReplicaPool) return app.locals.reportReplicaPool;
        if (app?.locals?.reportPool) return app.locals.reportPool;

        if (readOnly && this.databaseReplicaUrls.length > 0) {
            if (this.replicaPools.length === 0) {
                this.replicaPools = this.databaseReplicaUrls.map((connStr) => new Pool({ connectionString: connStr, max: 5 }));
            }
            return this.replicaPools[0];
        }

        if (!this.databaseUrl) return null;
        if (!this.primaryPool) {
            this.primaryPool = new Pool({ connectionString: this.databaseUrl, max: 5 });
        }
        return this.primaryPool;
    }

    /**
     * Executes a read query against read replica, automatically failing over to other replicas
     * or primary if the replica throws a connection error.
     */
    async executeRead(app, queryFn) {
        const readClient = this.getReadClient(app);
        if (!readClient) {
            throw new Error("No database client available for read");
        }

        try {
            const result = await queryFn(readClient);
            this.markReplicaHealthy(readClient);
            return result;
        } catch (err) {
            const isConnectionError = this.isConnectionFailure(err);
            if (isConnectionError) {
                this.markReplicaFailure(readClient);
                // Attempt fallback to primary if the failed client was a replica
                const primary = this.getPrimaryClient(app);
                if (primary && primary !== readClient) {
                    try {
                        const fallbackResult = await queryFn(primary);
                        this.markPrimaryHealthy();
                        return fallbackResult;
                    } catch (fallbackErr) {
                        this.markPrimaryFailure();
                        throw fallbackErr;
                    }
                }
            }
            throw err;
        }
    }

    /**
     * Executes a mutation strictly against primary.
     * Never routes mutations to read replicas.
     */
    async executeMutation(app, mutationFn) {
        const primary = this.getPrimaryClient(app);
        if (!primary) {
            const error = new Error("Primary database client not initialized");
            error.statusCode = 500;
            throw error;
        }

        if (!this.isPrimaryHealthy()) {
            const error = new Error("Primary database is currently unavailable; write operations are suspended");
            error.statusCode = 503;
            throw error;
        }

        try {
            const result = await mutationFn(primary);
            this.markPrimaryHealthy();
            return result;
        } catch (err) {
            if (this.isConnectionFailure(err)) {
                this.markPrimaryFailure();
                const error = new Error("Primary database connection failed; mutation aborted");
                error.statusCode = 503;
                error.originalError = err;
                throw error;
            }
            throw err;
        }
    }

    isConnectionFailure(err) {
        if (!err) return false;
        const msg = (err.message || '').toLowerCase();
        const code = (err.code || '').toLowerCase();
        return (
            code === 'econnrefused' ||
            code === 'etimedout' ||
            code === 'ehostunreach' ||
            msg.includes('connection refused') ||
            msg.includes('connection timeout') ||
            msg.includes('network error') ||
            msg.includes('failed to fetch') ||
            msg.includes('server closed the connection')
        );
    }
}

let defaultManager = null;
function getDatabaseManager(options) {
    if (!defaultManager || options) {
        defaultManager = new DatabaseManager(options);
    }
    return defaultManager;
}

module.exports = {
    DatabaseManager,
    getDatabaseManager,
};
