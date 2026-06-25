const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;


const stripeSecretKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || process.env.STRIPE_KEY;
const stripeLib = require('stripe')(stripeSecretKey);


const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';


const allowedOrigins = ['http://localhost:3000', process.env.FRONTEND_URL].filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());


const verifyToken = (req, res, next) => {
    if (!req.headers.authorization) {
        return res.status(401).send({ message: 'Unauthorized access' });
    }
    const token = req.headers.authorization.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: 'Unauthorized access' });
        req.decoded = decoded;
        next();
    });
};

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// GLOBAL DATABASE VARIABLES (Accessible globally across all routes)
let db, usersCollection, ticketsCollection, bookingsCollection;

// CRITICAL SERVERLESS MIDDLEWARE: Connects lazily and guarantees DB references exist before running endpoints
app.use(async (req, res, next) => {
    try {
        if (!client.topology || !client.topology.isConnected()) {
            await client.connect();
        }
        db = client.db("ticketBariDB");
        usersCollection = db.collection("users");
        ticketsCollection = db.collection("tickets");
        bookingsCollection = db.collection("bookings");
        next();
    } catch (err) {
        console.error("Database initialization connection failure:", err);
        res.status(500).send({ message: "Internal server database connection fault." });
    }
});

// ==========================================
// CORE SYSTEM ROUTES (Mounted synchronously)
// ==========================================
app.get('/', (req, res) => {
    res.send('TicketBari server core engine executing perfectly.');
});

app.get('/api/health', (req, res) => {
    res.send({ status: "alive", message: "Vercel serverless routing is fully operational!" });
});

// ==========================================
// AUTHENTICATION & SYNC (Handles Form & Google Signups)
// ==========================================
app.post('/users/sync', async (req, res) => {
    try {
        const { name, email, image, requestedRole } = req.body;

        if (!email) {
            return res.status(400).send({ message: "Email parameter is required for synchronization." });
        }

        const existingUser = await usersCollection.findOne({ email });
        
        if (existingUser) {
            // Generate a fresh token with their current DB role (e.g., 'vendor' or 'admin')
            const token = jwt.sign(
                { email: existingUser.email, role: existingUser.role }, 
                process.env.ACCESS_TOKEN_SECRET, 
                { expiresIn: '7d' }
            );
            return res.send({ user: existingUser, token });
        }

        // Setup clear fallback semantics for structured DB storage
        const newUser = {
            name: name || email.split('@')[0], // Fallback if Google name field returns undefined
            email,
            image: image || "",
            role: "user", // Base authorization level
            requestedRole: requestedRole === "vendor" ? "vendor" : "user",
            vendorVerification: requestedRole === "vendor" ? "pending" : "none",
            isFraud: false,
            createdAt: new Date()
        };

        const result = await usersCollection.insertOne(newUser);
        
        const token = jwt.sign(
            { email: newUser.email, role: newUser.role }, 
            process.env.ACCESS_TOKEN_SECRET, 
            { expiresIn: '7d' }
        );

        res.send({ user: { _id: result.insertedId, ...newUser }, token });
    } catch (error) {
        console.error("Synchronization Error:", error);
        res.status(500).send({ message: "Internal server validation synchronization error." });
    }
});

app.post('/jwt', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).send({ message: "Email is required to generate a token." });
        }

        const dbUser = await usersCollection.findOne({ email: email });
        const finalRole = dbUser ? dbUser.role : "user"; 

        const token = jwt.sign(
            { email: email, role: finalRole }, 
            process.env.ACCESS_TOKEN_SECRET, 
            { expiresIn: '7d' }
        );

        res.send({ token, role: finalRole });
    } catch (error) {
        console.error("JWT Generation Error:", error);
        res.status(500).send({ message: "Internal server error during token generation." });
    }
});

// ==========================================
// USER & ADMIN MANAGEMENT APIs
// ==========================================
app.get('/users', verifyToken, async (req, res) => {
    const users = await usersCollection.find().toArray();
    res.send(users);
});

app.patch('/users/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const { role, vendorVerification, isFraud } = req.body;
    const filter = { _id: new ObjectId(id) };
    const updateDoc = { $set: {} };
    
    if (role) updateDoc.$set.role = role;
    if (vendorVerification) updateDoc.$set.vendorVerification = vendorVerification;
    if (isFraud !== undefined) updateDoc.$set.isFraud = isFraud;

    const result = await usersCollection.updateOne(filter, updateDoc);

    if (isFraud) {
        const vendor = await usersCollection.findOne(filter);
        await ticketsCollection.updateMany(
            { vendorEmail: vendor.email }, 
            { $set: { verificationStatus: 'rejected', isAdvertised: false } }
        );
    }
    res.send(result);
});

app.delete('/users/:id', verifyToken, async (req, res) => {
    const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});

// ==========================================
// TICKET MANAGEMENT APIs
// ==========================================
app.get('/tickets', async (req, res) => {
    const { from, to, transport, sort, page = 1, limit = 6, status } = req.query;
    const query = {};
    
    if (status) query.verificationStatus = status;
    if (from) query.from = { $regex: from, $options: 'i' };
    if (to) query.to = { $regex: to, $options: 'i' };
    if (transport) query.transportType = transport;

    let sortOptions = { createdAt: -1 };
    if (sort === 'lowToHigh') sortOptions = { price: 1 };
    if (sort === 'highToLow') sortOptions = { price: -1 };

    const parsedPage = parseInt(page) || 1;
    const parsedLimit = parseInt(limit) || 6;
    const skip = (parsedPage - 1) * parsedLimit;

    try {
        const tickets = await ticketsCollection.find(query)
            .sort(sortOptions)
            .skip(skip)
            .limit(parsedLimit)
            .toArray();
            
        const total = await ticketsCollection.countDocuments(query);
        const totalPages = Math.ceil(total / parsedLimit);

        res.send({ tickets, totalPages: totalPages || 1 });
    } catch (error) {
        console.error("Database lookup error:", error);
        res.status(500).send({ message: "Internal server error" });
    }
});

app.get('/tickets/advertised', async (req, res) => {
    const tickets = await ticketsCollection.find({ isAdvertised: true }).limit(6).toArray();
    res.send(tickets);
});

app.post('/tickets', verifyToken, async (req, res) => {
    const vendorCheck = await usersCollection.findOne({ email: req.body.vendorEmail });
    if (vendorCheck?.isFraud) {
        return res.status(403).send({ message: "Fraudulent vendors are forbidden from posting tickets." });
    }

    const ticketData = {
        ...req.body,
        verificationStatus: 'approved', 
        isAdvertised: false,
        createdAt: new Date()
    };
    const result = await ticketsCollection.insertOne(ticketData);
    res.send(result);
});

app.patch('/tickets/:id', verifyToken, async (req, res) => {
    try {
        const id = req.params.id;
        const { _id, createdAt, verificationStatus, vendorEmail, ...updateFields } = req.body;

        const result = await ticketsCollection.updateOne(
            { _id: new ObjectId(id) }, 
            { $set: updateFields }
        );

        res.send(result);
    } catch (error) {
        console.error("Error updating ticket:", error);
        res.status(500).send({ message: "Internal server error updating ticket details" });
    }
});

app.delete('/tickets/:id', verifyToken, async (req, res) => {
    const result = await ticketsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});

// ==========================================
// RESERVATION & BOOKING APIs
// ==========================================
app.get('/bookings', verifyToken, async (req, res) => {
    const { userEmail, vendorEmail } = req.query;
    let query = {};
    if (userEmail) query.userEmail = userEmail;
    if (vendorEmail) query.vendorEmail = vendorEmail;
    
    const bookings = await bookingsCollection.find(query).toArray();
    res.send(bookings);
});

app.post('/bookings', verifyToken, async (req, res) => {
    const bookingData = {
        ...req.body,
        status: 'pending',
        createdAt: new Date()
    };
    const result = await bookingsCollection.insertOne(bookingData);
    res.send(result);
});

app.patch('/bookings/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const filter = { _id: new ObjectId(id) };
    
    const result = await bookingsCollection.updateOne(filter, { $set: { status } });

    if (status === 'paid') {
        const booking = await bookingsCollection.findOne(filter);
        await ticketsCollection.updateOne(
            { _id: new ObjectId(booking.ticketId) },
            { $inc: { quantity: -booking.quantity } }
        );
    }
    res.send(result);
});

app.get('/vendor-stats', verifyToken, async (req, res) => {
    const { email } = req.query;
    const totalTicketsAdded = await ticketsCollection.countDocuments({ vendorEmail: email });
    const vendorPaidBookings = await bookingsCollection.find({ vendorEmail: email, status: 'paid' }).toArray();

    const totalTicketsSold = vendorPaidBookings.reduce((sum, b) => sum + b.quantity, 0);
    const totalRevenue = vendorPaidBookings.reduce((sum, b) => sum + b.totalPrice, 0);

    res.send({ totalTicketsAdded, totalTicketsSold, totalRevenue });
});

// ==========================================
// SECURE STRIPE CHECKOUT ROUTE INTEGRATION
// ==========================================
app.post('/create-checkout-session', verifyToken, async (req, res) => {
    const { bookingId, title, totalPrice, quantity, ticketId } = req.body;

    try {
        const currentTicket = await ticketsCollection.findOne({ _id: new ObjectId(ticketId) });
        if (!currentTicket || currentTicket.quantity < parseInt(quantity)) {
            return res.status(400).send({ message: "Requested slots are no longer available in inventory stock." });
        }

        const session = await stripeLib.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: title },
                    unit_amount: Math.round((totalPrice / quantity) * 100), 
                },
                quantity: parseInt(quantity),
            }],
            mode: 'payment',
            success_url: `${frontendUrl}/bookings/success?bookingId=${bookingId}&ticketId=${ticketId}&qty=${quantity}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/dashboard/user`,
        });

        res.send({ url: session.url });
    } catch (error) {
        console.error("Stripe gateway payload failure context:", error);
        res.status(500).send({ message: "Payment session initialization failed" });
    }
});

app.patch('/verify-payment', verifyToken, async (req, res) => {
    const { bookingId, ticketId, quantity, sessionId } = req.body;

    try {
        if (!stripeSecretKey) {
            return res.status(500).send({ message: "Stripe credentials missing inside backend .env file configuration." });
        }

        const session = await stripeLib.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== 'paid') {
            return res.status(400).send({ message: "Transaction verification incomplete." });
        }

        const checkBooking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) });
        if (!checkBooking) {
            return res.status(404).send({ message: "Target booking reference not found." });
        }
        
        if (checkBooking.status === 'paid') {
            return res.send({ message: "Already processed", success: true });
        }

        await bookingsCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            { 
                $set: { 
                    status: 'paid', 
                    transactionId: session.id, 
                    paymentDate: new Date()    
                } 
            }
        );

        const activeTicketId = ticketId || checkBooking.ticketId;
        if (activeTicketId) {
            await ticketsCollection.updateOne(
                { _id: new ObjectId(activeTicketId) },
                { $inc: { quantity: -parseInt(quantity || checkBooking.quantity || 0) } }
            );
        }

        res.send({ success: true });
    } catch (error) {
        console.error("Backend validation error processing data sync:", error);
        res.status(500).send({ message: "Internal server error verification framework" });
    }
});

app.delete('/bookings/:id', verifyToken, async (req, res) => {
    const id = req.params.id;
    try {
        const result = await bookingsCollection.deleteOne({ _id: new ObjectId(id), status: 'pending' });
        res.send(result);
    } catch (error) {
        res.status(500).send({ message: "Could not remove target item." });
    }
});

// Safeguard app.listen for local development environment
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server executing safely on port ${port}`);
    });
}

// CRITICAL EXPORT FOR VERCEL DEPLOYMENT
module.exports = (req, res) => {
    return app(req, res);
};