require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testBridge() {
    console.log("Starting Checkpoint 2 Bridge Test...");

    try {
        // 1. Get Alice's public key from the Stellar CLI
        const aliceAddress = execSync('stellar keys address alice').toString().trim();
        console.log(`\nFound Alice: ${aliceAddress}`);
        
        // Let's create a brand new customer (Dave) so the smart contract doesn't block us for double-billing
        console.log("\nGenerating new test customer (Dave)...");
        try { execSync('stellar keys generate dave --network testnet --fund'); } catch(e) {}
        const daveAddress = execSync('stellar keys address dave').toString().trim();
        console.log(`Found Dave: ${daveAddress}`);

        const ORBIT_CONTRACT = process.env.ORBIT_CONTRACT_ID;
        const USDC_CONTRACT = execSync('stellar contract id asset --asset native --network testnet').toString().trim();

        console.log("Dave approving allowance and creating vault on-chain...");
        // Dave approves the contract
        execSync(`stellar contract invoke --id ${USDC_CONTRACT} --source dave --network testnet -- approve --from ${daveAddress} --spender ${ORBIT_CONTRACT} --amount 500000000 --live_until_ledger 5000000`);
        // Dave creates the vault
        execSync(`stellar contract invoke --id ${ORBIT_CONTRACT} --source dave --network testnet -- create_vault --user ${daveAddress} --merchant ${aliceAddress} --token ${USDC_CONTRACT} --amount_per_interval 290000000 --interval_seconds 2592000`);

        // 2. Seed Database: Create Merchant (Alice)
        console.log("\nSeeding Supabase Database...");
        let { data: merchant, error: mErr } = await supabase
            .from('merchants')
            .insert([{ wallet_address: aliceAddress, name: 'MailKit Pro (Test)' }])
            .select().single();
            
        if (mErr) {
            const { data: existing } = await supabase.from('merchants').select().eq('wallet_address', aliceAddress).single();
            merchant = existing;
        }

        // 3. Seed Database: Create Plan via the Express API (Simulating Postman)
        console.log("\nHitting POST /plans API...");
        const planResponse = await fetch('http://localhost:3001/plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                merchant_id: merchant.id,
                name: 'Pro Tier',
                usdc_amount: 290000000,
                interval_seconds: 2592000
            })
        });
        const planData = await planResponse.json();
        console.log("API Response:", planData);
        
        // 4. Seed Database: Create a Subscription directly
        let { data: sub } = await supabase
            .from('subscriptions')
            .insert([{
                plan_id: planData.plan.id,
                customer_wallet_address: daveAddress,
                next_billing_date: new Date().toISOString()
            }])
            .select().single();

        console.log(`Created Subscription ID: ${sub.id}`);

        // 5. Prepare the pull. Sign pullData.transaction_xdr with Alice's wallet,
        // then send it to POST /submit-pull; the API never reads Alice's secret.
        console.log("\nHitting POST /trigger-pull API to prepare the smart contract call...");
        const pullResponse = await fetch('http://localhost:3001/trigger-pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription_id: sub.id })
        });
        
        const pullData = await pullResponse.json();
        console.log("API Response:", pullData);

        if (pullResponse.ok) {
            console.log("\nCHECKPOINT 2 SUCCESS! Unsigned XDR is ready for wallet signing.");
        } else {
            console.log("\nAPI returned an error.");
        }

    } catch (err) {
        console.error("\nTest Failed:", err.message);
    }
}

testBridge();
