require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");
const { default: Stripe } = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).send({ message: "forbidden access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nugjc.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("Mongodb connected");

    const database = client.db("micro_tasks");
    const usersCollection = database.collection("users");
    const buyerTaskCollection = database.collection("buyer-tasks");
    const buyerPaymentCollection = database.collection("buyer-payments");
    const submissionsCollection = database.collection("submissions");
    const withdrawalsCollection = database.collection("withdrawals");

    const verifyBuyer = async (req, res, next) => {
      const userEmail = req.user?.email;

      if (!userEmail) {
        return res.status(401).send({ message: "unauthorize user" });
      }
      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "buyer") {
        return res.status(403).send({ message: "forbidden" });
      }
      next();
    };

    // JWT route
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(401).send({ message: "unauthorize user" });
      }

      const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "7d",
      });
      res.send({ token });
    });

    app.get("/logout", (req, res) => {
      res.send({
        success: true,
        message: "logged out",
      });
    });

    app.get("/stats/:email", async (req, res) => {
      const email = req.params.email;
      const tasks = await buyerTaskCollection
        .find({ buyer_email: email })
        .toArray();
      const totalTasks = tasks.length;
      const pendingWorkersr = tasks.reduce(
        (sum, task) => sum + task.required_workers,
        0
      );
      const totalPaid = tasks.reduce(
        (sum, task) => sum + (task.payable_amount || 0),
        0
      );

      res.send({ totalTasks, pendingWorkersr, totalPaid });
    });

    app.get("/submissions/review/:email", async (req, res) => {
      const email = req.params.email;
      const tasks = await buyerTaskCollection
        .find({ buyer_email: email })
        .toArray();
      const taskIds = tasks.map((task) => task._id.toString());

      const submissions = await submissionsCollection
        .find({
          task_id: { $in: taskIds },
          status: "pending",
        })
        .toArray();

      res.send(submissions);
    });

    app.get("/users/withdrawals/:email", async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "Access denied" });
      }
      const withdrawals = await withdrawalsCollection
        .find({ worker_email: email })
        .sort({ withdraw_date: -1 })
        .toArray();
      res.send(withdrawals);
    });
    app.patch("/submissions/approve/:id", async (req, res) => {
      const id = req.params.id;
      const submission = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!submission) return res.status(404).send("Not found");

      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      // Increase worker's coins
      await usersCollection.updateOne(
        { email: submission.worker_email },
        { $inc: { coins: submission.coin || 0 } }
      );

      res.send({ message: "Submission approved and coins added" });
    });

    app.patch("/submissions/reject/:id", async (req, res) => {
      const id = req.params.id;
      const submission = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!submission) return res.status(404).send("Not found");

      // Update submission status
      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );

      // Increase required workers by 1 for that task
      await buyerTaskCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: 1 } }
      );

      res.send({ message: "Submission rejected and worker slot restored" });
    });

    app.post("/users/withdrawals", async (req, res) => {
      const { worker_email, withdrawal_coin } = req.body;

      const user = await usersCollection.findOne({ email: worker_email });
      if (!user) return res.status(404).send({ message: "User not found" });

      if (user.coins < withdrawal_coin) {
        return res.status(400).send({ message: "Not enough coins" });
      }

      const result = await withdrawalsCollection.insertOne(req.body);
      await usersCollection.updateOne(
        { email: worker_email },
        { $inc: { coins: -withdrawal_coin } }
      );

      res.send({ success: true, result });
    });

    app.get("/submissions", async (req, res) => {
      const email = req.query.workerEmail;
      const result = await submissionsCollection
        .find({ worker_email: email })
        .toArray();
      res.send(result);
    });

    app.post("/submissions", async (req, res) => {
      const submission = req.body;
      submission.status = "pending";
      submission.current_date = new Date().toLocaleDateString();
      const result = await submissionsCollection.insertOne(submission);
      res.send(result);
    });

    app.get("/payments/:email", async (req, res) => {
      const email = req.params.email;
      const payments = await buyerPaymentCollection.find({ email }).toArray();
      res.send(payments);
    });

    app.post("/create-payment-intent", async (req, res) => {
      const { price } = req.body;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    app.post("/payments", async (req, res) => {
      const { email, price, coins, transactionId } = req.body;

      const saveResult = await buyerPaymentCollection.insertOne(req.body);

      const updateUser = await usersCollection.updateOne(
        { email },
        { $inc: { coins: coins } }
      );

      res.send({ success: true });
    });

    app.get("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const task = await buyerTaskCollection.findOne({ _id: new ObjectId(id) });
      res.send(task);
    });

    app.get("/tasks", async (req, res) => {
      const tasks = await buyerTaskCollection
        .find({ required_workers: { $gt: 0 } })
        .toArray();
      res.send(tasks);
    });
    app.patch("/tasks/:id", async (req, res) => {
      const taskId = req.params.id;

      if (!ObjectId.isValid(taskId)) {
        return res.status(400).send({ message: "Invalid Task ID" });
      }

      try {
        const updatedFields = {
          task_title: req.body.task_title,
          task_detail: req.body.task_detail,
          submission_info: req.body.submission_info,
        };

        const result = await buyerTaskCollection.updateOne(
          { _id: new ObjectId(taskId) },
          { $set: updatedFields }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Task not found" });
        }

        res.send({ message: "Task updated successfully" });
      } catch (error) {
        console.error("Update error:", error);
        res
          .status(500)
          .send({ message: "Failed to update task", error: error.message });
      }
    });

    app.delete("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const { userEmail, isCompleted, refundAmount } = req.body;

      const deleteResult = await buyerTaskCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (!isCompleted) {
        await usersCollection.updateOne(
          { email: userEmail },
          { $inc: { coins: refundAmount } }
        );
      }

      res.send({ deleteResult, refund: isCompleted ? 0 : refundAmount });
    });

    app.get("/tasks/user/:email", async (req, res) => {
      const result = await buyerTaskCollection.find().toArray();
      res.send(result);
    });

    app.post("/tasks", async (req, res) => {
      try {
        const taskData = req.body;
        const result = await buyerTaskCollection.insertOne(taskData);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "failed to add task", error });
      }
    });

    app.patch("/users/add-coins", async (req, res) => {
      const { email, coins } = req.body;
      const filter = { email };

      const updateDoc = {
        $inc: { coins: coins },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.patch("/users/reduce-coins", async (req, res) => {
      const { email, coins } = req.body;
      const user = await usersCollection.findOne({ email });

      if (!user || user.coins < coins) {
        return res.status(400).send({ message: "not enough coins" });
      }
      const result = await usersCollection.updateOne(
        { email },
        {
          $inc: { coins: -coins },
        }
      );
      res.send(result);
    });

    app.get("/users/coin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      if (!user) {
        return res.send({ coins: 0 });
      }
      res.send({ coins: user.coins || 0 });
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "Access denied" });
      }
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });
    app.post("/users", async (req, res) => {
      const user = req.body;
      console.log(user);
      const existing = await usersCollection.findOne({ email: user.email });
      if (existing) {
        return res.send({ message: "User already exists" });
      }

      const newUser = {
        name: user.name,
        email: user.email,
        photoURL: user.photoURL,
        role: user.role || "worker",
        coins: user.coins || 0,
        createdAt: new Date(),
      };
      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });
    app.get("/profile", verifyJWT, async (req, res) => {
      const email = req.user.email;

      try {
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).send({ message: "user not found" });
        }
        res.send(user);
      } catch (error) {
        res.status(500).send({ message: "server error" });
      }
    });

    app.patch("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const filter = { email };
      const updateDoc = {
        $set: { role: "admin" },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.get("/users", async (req, res) => {
      const users = await usersCollection.find().toArray();
      res.send(users);
    });

    // Sample route
    app.get("/", (req, res) => {
      res.send("Server is running");
    });

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.log(error);
  }
}
run();
