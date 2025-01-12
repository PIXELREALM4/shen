const express = require('express');
const cors = require('cors');
const web3 = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const base58 = require('base-58');
require('dotenv').config();
const fs = require('fs');

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Constants
const NETWORK = 'mainnet-beta';
const TOKEN_MINT = process.env.TOKEN_MINT;
const PRESALE_WALLET_PRIVATE_KEY = process.env.PRESALE_WALLET_PRIVATE_KEY;
const TOKEN_DECIMALS = 9;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Initialize connection
const connection = new web3.Connection(
    'https://api.mainnet-beta.solana.com',
    'confirmed'
);

// Initialize presale wallet - add error handling
let presaleKeypair;
try {
    if (!process.env.PRESALE_WALLET_PRIVATE_KEY) {
        throw new Error('PRESALE_WALLET_PRIVATE_KEY is not defined in .env file');
    }
    
    const decodedKey = base58.decode(process.env.PRESALE_WALLET_PRIVATE_KEY);
    presaleKeypair = web3.Keypair.fromSecretKey(
        Uint8Array.from(decodedKey)
    );
    console.log('Presale wallet loaded successfully:', presaleKeypair.publicKey.toString());
} catch (error) {
    console.error('Error initializing presale wallet:', error);
    process.exit(1); // Exit if we can't initialize the wallet
}

// Store pending transactions
const pendingTransactions = new Map();

// Verify payment transaction
async function verifyPayment(signature, expectedAmount, currency) {
    try {
        const tx = await connection.getTransaction(signature);
        if (!tx) return false;

        if (currency === 'SOL') {
            // Verify SOL transfer
            const transfer = tx.transaction.message.instructions.find(
                ix => ix.programId.equals(web3.SystemProgram.programId)
            );
            return transfer && transfer.data.readBigInt64LE(0) === BigInt(expectedAmount);
        } else {
            // Verify USDT transfer
            const transfer = tx.transaction.message.instructions.find(
                ix => ix.programId.equals(splToken.TOKEN_PROGRAM_ID)
            );
            return transfer && transfer.data.readBigInt64LE(0) === BigInt(expectedAmount);
        }
    } catch (error) {
        console.error('Payment verification failed:', error);
        return false;
    }
}

// Send tokens to buyer
async function sendTokens(buyerAddress, amount) {
    try {
        const buyerPublicKey = new web3.PublicKey(buyerAddress);
        const tokenMint = new web3.PublicKey(TOKEN_MINT);

        // Get or create buyer's token account
        const buyerATA = await splToken.Token.getAssociatedTokenAddress(
            splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
            splToken.TOKEN_PROGRAM_ID,
            tokenMint,
            buyerPublicKey
        );

        // Get presale token account
        const presaleATA = await splToken.Token.getAssociatedTokenAddress(
            splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
            splToken.TOKEN_PROGRAM_ID,
            tokenMint,
            presaleKeypair.publicKey
        );

        // Create transaction
        const transaction = new web3.Transaction();

        // Add create ATA instruction if needed
        const buyerAccount = await connection.getAccountInfo(buyerATA);
        if (!buyerAccount) {
            transaction.add(
                splToken.Token.createAssociatedTokenAccountInstruction(
                    splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
                    splToken.TOKEN_PROGRAM_ID,
                    tokenMint,
                    buyerATA,
                    buyerPublicKey,
                    presaleKeypair.publicKey
                )
            );
        }

        // Add transfer instruction
        transaction.add(
            splToken.Token.createTransferInstruction(
                splToken.TOKEN_PROGRAM_ID,
                presaleATA,
                buyerATA,
                presaleKeypair.publicKey,
                [],
                amount
            )
        );

        // Sign and send transaction
        const signature = await web3.sendAndConfirmTransaction(
            connection,
            transaction,
            [presaleKeypair]
        );

        return signature;
    } catch (error) {
        console.error('Token transfer failed:', error);
        throw error;
    }
}

// API Endpoints
app.post('/api/initiate-purchase', (req, res) => {
    try {
        const { buyerAddress, amount, currency } = req.body;
        const transactionId = Date.now().toString();
        
        pendingTransactions.set(transactionId, {
            buyerAddress,
            amount,
            currency,
            status: 'pending'
        });

        res.json({ transactionId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { transactionId, signature } = req.body;
        const transaction = pendingTransactions.get(transactionId);

        if (!transaction) {
            return res.status(404).json({ error: 'Transaction not found' });
        }

        // Verify payment
        const isValid = await verifyPayment(
            signature,
            transaction.amount,
            transaction.currency
        );

        if (!isValid) {
            return res.status(400).json({ error: 'Invalid payment' });
        }

        // Calculate token amount
        const tokenAmount = transaction.currency === 'USDT' 
            ? Math.floor((transaction.amount / 0.001) * Math.pow(10, TOKEN_DECIMALS))
            : Math.floor((transaction.amount / 0.000005) * Math.pow(10, TOKEN_DECIMALS));

        // Send tokens
        const tokenSignature = await sendTokens(transaction.buyerAddress, tokenAmount);

        // Update transaction status
        pendingTransactions.set(transactionId, {
            ...transaction,
            status: 'completed',
            tokenSignature
        });

        res.json({ 
            success: true, 
            signature: tokenSignature 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/save-progress', (req, res) => {
    const data = req.body;
    fs.writeFileSync('progress.json', JSON.stringify(data, null, 2));
    res.status(200).send('Progress saved');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 