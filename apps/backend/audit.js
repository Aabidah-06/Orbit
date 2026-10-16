const { z } = require('zod');

/**
 * Audit log schema for query validation
 */
const getAuditLogsQuerySchema = z.object({
    merchant_id: z.string().uuid("merchant_id must be a valid UUID"),
    action: z.string().optional(),
    resource_type: z.string().optional(),
    start_date: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
    end_date: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Extracts client IP from Express request
 */
const getClientIp = (req) => {
    if (!req) return null;
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || null;
};

/**
 * Extracts actor address from request headers or body
 */
const getActorAddress = (req, fallback = null) => {
    if (!req) return fallback;
    return (
        req.headers?.['x-actor-address'] ||
        req.body?.actor_address ||
        req.body?.customer_wallet_address ||
        fallback
    );
};

/**
 * Writes an immutable audit log record to Supabase
 */
const writeAuditLog = async (supabase, {
    merchantId,
    actorAddress = null,
    action,
    resourceType,
    resourceId = null,
    ipAddress = null,
    changesBefore = null,
    changesAfter = null,
}) => {
    if (!supabase) return null;

    try {
        const record = {
            merchant_id: merchantId,
            actor_address: actorAddress,
            action,
            resource_type: resourceType,
            resource_id: resourceId ? String(resourceId) : null,
            ip_address: ipAddress,
            changes_before: changesBefore,
            changes_after: changesAfter,
        };

        const { error } = await supabase
            .from('audit_logs')
            .insert([record]);

        if (error) {
            console.error("Failed to write audit log:", error);
            return null;
        }

        return record;
    } catch (err) {
        console.error("Exception writing audit log:", err);
        return null;
    }
};

module.exports = {
    getAuditLogsQuerySchema,
    getClientIp,
    getActorAddress,
    writeAuditLog,
};
