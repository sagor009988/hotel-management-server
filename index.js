const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Timestamp,
} = require("mongodb");
const jwt = require("jsonwebtoken");

const port = process.env.PORT || 8000;

// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// email send
const sendEmail = (emailAddress, emailData) => {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.TRANSPORTER_EMAIL,
      pass: process.env.TRANSPORTER_PASS,
    },
  });
  // Callback style
  transporter.verify((error, success) => {
    if (error) {
      console.error(error);
    } else {
      console.log("Server is ready to take our messages");
    }
  });
  const emailBody = {
    from: `"HotelRoom Management" <${process.env.TRANSPORTER_EMAIL}>`,
    to: emailAddress,
    subject: emailData.subject,

    html: emailData.message,
  };
  transporter.sendMail(emailBody, (error) => {
    if (error) {
      console.log(error);
    } else {
      console.log("Email send" );
    }
  });

  console.log("Message sent:", );
};

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.okjp9zn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // collections
    const db = client.db("hotel-management");
    const roomsCollection = db.collection("rooms");
    const usersCollection = db.collection("users");
    const bookingsCollection = db.collection("bookings");

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result && result?.role !== "admin")
        return res.status(401).send({ message: "Bad Access" });
      next();
    };
    // verify host
    const verifyHost = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await usersCollection.findOne(query);
      if (!result && result?.role !== "host")
        return res.status(401).send({ message: "Bad Access" });
      next();
    };

    // auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });
    // Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // payment create intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const price = req.body.price;
      const priceInCent = parseInt(price) * 100;
      if (!price || priceInCent < 1) return;
      // generate client secret
      const { client_secret } = await stripe.paymentIntents.create({
        amount: priceInCent,
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
        },
      });
      // send client secret as a response
      res.send({ clientSecret: client_secret });
    });

    // save User
    app.put("/user", async (req, res) => {
      const user = req.body;

      const query = { email: user?.email };
      const options = { upsert: true };

      const isExist = await usersCollection.findOne(query);

      if (isExist) {
        // If request is to update status to "Requested"
        if (user?.status && user.status === "Requested") {
          const result = await usersCollection.updateOne(query, {
            $set: { status: user.status },
          });
          return res.send(result);
        } else {
          return res.send(isExist);
        }
      }

      // If user doesn't exist, insert with full data
      const updatedDoc = {
        $set: {
          ...user,
          Timestamp: Date.now(),
        },
      };

      const result = await usersCollection.updateOne(
        query,
        updatedDoc,
        options
      );
      return res.send(result);
    });

    // get a user info by email from bd
    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    // update user role
    app.patch(
      "/user/update/:email",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        console.log(email);

        const query = { email };
        const user = req.body;
        const updatedDoc = {
          $set: {
            ...user,
            Timestamp: Date.now(),
          },
        };
        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      }
    );

    // get all users
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // get all rooms
    app.get("/rooms", async (req, res) => {
      const category = req.query.category;

      let query = {};
      if (category && category !== "null") query = { category };
      const result = await roomsCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/my-listings/:email", async (req, res) => {
      const email = req.params.email;
      let query = { "host.email": email };
      const result = await roomsCollection.find(query).toArray();
      res.send(result);
    });
    // add a new room
    app.post("/room", verifyToken, verifyHost, async (req, res) => {
      const roomData = req.body;
      const result = await roomsCollection.insertOne(roomData);
      res.send(result);
    });

    // update roomData
    app.put("/room/update/:id", verifyToken, verifyHost, async (req, res) => {
      const id = req.params.id;
      const roomData = req.body;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: roomData,
      };
      const result = await roomsCollection.updateOne(query, updatedDoc);
      res.send(result);
    });
    // delete a room
    app.delete("/roomDelete/:id", verifyToken, verifyHost, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await roomsCollection.deleteOne(query);
      res.send(result);
    });

    // get single room details
    app.get("/room/:id", async (req, res) => {
      const id = req.params.id;
      const result = await roomsCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // save a booking data in db
    app.post("/bookings", async (req, res) => {
      const bookingData = req.body;
      // save booking info
      const result = await bookingsCollection.insertOne(bookingData);
      // send email to guest
      sendEmail(bookingData?.guest?.email, {
        subject: "Your room booking is successful!!!!!!",
        message: `You have successfully booked a room throw hotelRoom management .transaction id:${bookingData.transactionId}`,
      });
      // send email to the host
      sendEmail(bookingData?.host?.email, {
        subject: "Your room got booked successful!!!!!!",
        message: `Get ready to wellCome ${bookingData?.guest?.name}`,
      });

      res.send(result);
    });

    // update room status
    app.patch("/room/status/:id", async (req, res) => {
      const id = req.params.id;
      const status = req.body.status;
      const query = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: { booked: status },
      };
      const result = await roomsCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    // manage bookings
    app.get("/manage-bookings/:email", async (req, res) => {
      const email = req.params.email;
      const query = { "host.email": email };

      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    });

    // get my bookings
    app.get("/my-bookings/:email", async (req, res) => {
      const email = req.params.email;
      const query = { "guest.email": email };
      const result = await bookingsCollection.find(query).toArray();
      res.send(result);
    });

    // cancel bookings
    app.delete("/booking/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.deleteOne(query);
      res.send(result);
    });
    // admin statistics
    app.get("/admin-stat", verifyToken, verifyAdmin, async (req, res) => {
      const bookingsDetails = await bookingsCollection
        .find(
          {},
          {
            projection: {
              date: 1,
              price: 1,
            },
          }
        )
        .toArray();
      const chartData = bookingsDetails.map((booking) => {
        const day = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth();
        const data = [`${day}/${month}`, booking.price];
        return data;
      });
      // ['Day', 'Sales'] add in this array;
      chartData.unshift(["Day", "Sales"]);

      const totalUser = await usersCollection.countDocuments();
      const totalRooms = await roomsCollection.countDocuments();
      const totalPrice = bookingsDetails.reduce(
        (sum, item) => sum + item.price,
        0
      );
      res.send({
        totalUser,
        totalRooms,
        totalPrice,
        totalBookings: bookingsDetails.length,
        chartData,
      });
    });
    // host statistics
    app.get("/host-stat", verifyToken, verifyHost, async (req, res) => {
      const { email } = req?.user;
      const bookingsDetails = await bookingsCollection
        .find(
          { "host.email": email },
          {
            projection: {
              date: 1,
              price: 1,
            },
          }
        )
        .toArray();
      const chartData = bookingsDetails.map((booking) => {
        const day = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth();
        const data = [`${day}/${month}`, booking.price];
        return data;
      });
      // ['Day', 'Sales'] add in this array;
      chartData.unshift(["Day", "Sales"]);

      const totalUser = await usersCollection.countDocuments();
      const totalRooms = await roomsCollection.countDocuments();
      const totalPrice = bookingsDetails.reduce(
        (sum, item) => sum + item.price,
        0
      );
      const { Timestamp } = await usersCollection.findOne({ email });
      res.send({
        totalUser,
        totalRooms,
        totalPrice,
        totalBooking: bookingsDetails.length,
        chartData,
        Timestamp,
      });
    });

    app.get("/guest-stat", verifyToken, async (req, res) => {
      const { email } = req.user;
      const bookingsDetails = await bookingsCollection
        .find({ "guest.email": email })
        .toArray();

      const chartData = bookingsDetails.map((booking) => {
        const day = new Date(booking.date).getDate();
        const month = new Date(booking.date).getMonth();
        const data = [`${day}/${month}`, booking?.price];
        return data;
      });
      chartData.unshift(["day", "sales"]);

      const totalPrice = bookingsDetails.reduce(
        (sum, item) => sum + item.price,
        0
      );
      const { Timestamp } = await usersCollection.findOne({ email });
      res.send({
        totalPrice,
        Timestamp,
        totalBooking: bookingsDetails?.length,
        chartData,
      });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from StayVista Server..");
});

app.listen(port, () => {
  console.log(`StayVista is running on port ${port}`);
});
