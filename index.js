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

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",");

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

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

    // JWT route

    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No token provided" });
      }

      const token = authHeader.split(" ")[1];

      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res
            .status(400)
            .send({ message: "Invalid token. Please login again." });
        }

        req.decoded = decoded;
        next();
      });
    };
    const generateToken = (user) => {
      return jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "72h",
      });
    };
    app.post("/jwt", async (req, res) => {
      const { email } = req.body;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const token = generateToken({ email });

      res.send({ token });
    });
    app.get("/logout", (req, res) => {
      res.send({ message: "Logged out" });
    });

    const verifyWorker = async (req, res, next) => {
      const email = req.decoded?.email;
      if (!email) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No email found" });
      }
      try {
        const user = await usersCollection.findOne({ email: email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }
        if (user.role !== "worker") {
          return res.status(403).send({ message: "Forbidden: Workers only" });
        }
        next();
      } catch (error) {
        res.status(500).send({ message: "Internal server error", error });
      }
    };

    const verifyBuyer = async (req, res, next) => {
      const email = req.decoded?.email;
      if (!email) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No email found" });
      }
      try {
        const user = await usersCollection.findOne({ email: email });
        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }
        if (user.role !== "buyer") {
          return res.status(403).send({ message: "Forbidden: Workers only" });
        }
        next();
      } catch (error) {
        res.status(500).send({ message: "Internal server error", error });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded?.email;
      if (!email) {
        return res
          .status(401)
          .send({ message: "Unauthorized: No email found" });
      }
      try {
        const user = await usersCollection.findOne({ email: email });
        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }
        if (user.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: Workers only" });
        }
        next();
      } catch (error) {
        res.status(500).send({ message: "Internal server error", error });
      }
    };

    app.post("/users", async (req, res) => {
      const user = req.body;
      const existingUser = await usersCollection.findOne({
        email: user?.email,
      });

      if (existingUser) {
        return res.status(409).send({ message: "User already exists" });
      }

      const newUser = {
        name: user.name,
        email: user.email,
        password: user.password || null,
        photoURL: user.photoURL || "",
        role: user.role || "worker",
        coins: user.coins || 0,
        createdAt: new Date(),
      };

      await usersCollection.insertOne(newUser);
      res.send({ message: "User created" });
    });

    app.post("/login", async (req, res) => {
      const { email, password } = req.body;
      const user = await usersCollection.findOne({ email });

      if (!user || user.password !== password) {
        return res.status(401).send({ message: "Invalid email or password" });
      }

      const token = generateToken(email);
      res.send({ token });
    });

    app.get("/profile", verifyToken, async (req, res) => {
      const email = req.query.email;

      if (req.decoded.email !== email) {
        return res.status(403).send({ message: "forbidden" });
      }

      const user = await usersCollection.findOne(
        { email },
        { projection: { password: 0 } }
      );
      res.send(user);
    });

    app.get("/admin/stats", async (req, res) => {
      const users = await usersCollection.find().toArray();
      const withdrawals = await withdrawalsCollection
        .find({ status: "approved" })
        .toArray();

      const totalWorkers = users.filter((u) => u.role === "worker").length;
      const totalBuyers = users.filter((u) => u.role === "buyer").length;
      const totalCoins = users.reduce((sum, u) => sum + (u.coins || 0), 0);
      const totalPayments = withdrawals.reduce(
        (sum, w) => sum + (w.withdrawal_amount || 0),
        0
      );

      res.send({ totalWorkers, totalBuyers, totalCoins, totalPayments });
    });
    app.get("/admin/withdrawals", async (req, res) => {
      const pending = await withdrawalsCollection
        .find({ status: "pending" })
        .toArray();
      res.send(pending);
    });

    app.patch("/admin/withdraw-approve/:id", async (req, res) => {
      const id = req.params.id;
      const { email, coins } = req.body;

      // Approve the withdrawal
      await withdrawalsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      // Deduct coins from user
      await usersCollection.updateOne({ email }, { $inc: { coins: -coins } });

      res.send({ success: true });
    });

    app.get("/buyer-stats", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ message: "Email required" });

      try {
        const buyerTasks = await buyerTaskCollection
          .find({ buyer_email: email })
          .toArray();
        const totalTasks = buyerTasks.length;

        const pendingWorkers = buyerTasks.reduce((acc, task) => {
          return acc + (task.required_workers || 0);
        }, 0);

        const approvedSubmissions = await submissionsCollection
          .find({ buyer_email: email, status: "approved" })
          .toArray();

        const totalPaid = approvedSubmissions.reduce((acc, sub) => {
          return acc + (sub.payable_amount || 0);
        }, 0);

        res.send({ totalTasks, pendingWorkers, totalPaid });
      } catch (error) {
        console.error("buyer-stats error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    app.get("/worker-stats", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ message: "Email required" });

      try {
        const submissions = await submissionsCollection
          .find({ worker_email: email })
          .toArray();

        const totalSubmission = submissions.length;

        const totalPending = submissions.filter(
          (sub) => sub.status === "pending"
        ).length;

        const totalEarning = submissions
          .filter((sub) => sub.status === "approved")
          .reduce((sum, sub) => sum + (sub.payable_amount || 0), 0);

        res.send({ totalSubmission, totalPending, totalEarning });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Internal server error" });
      }
    });
    app.patch(
      "/users/update-coins/:email",
      verifyToken,
      verifyWorker,
      async (req, res) => {
        const email = req.params.email;
        const { coins } = req.body;

        const result = await usersCollection.updateOne(
          { email },
          { $set: { coins } }
        );

        res.send(result);
      }
    );
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
        .sort({ withdrawal_coin: -1 })
        .toArray();
      res.send(withdrawals);
    });
    app.get("/approved-submissions", async (req, res) => {
      const email = req.query.workerEmail;
      if (!email)
        return res.status(400).send({ message: "Worker email required" });

      try {
        const submissions = await submissionsCollection
          .find({ worker_email: email, status: "approved" })
          .toArray();

        res.send(submissions);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    app.patch("/submissions/approve/:id", async (req, res) => {
      const { id } = req.params;

      const submission = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!submission)
        return res.status(404).send({ message: "Submission not found" });

      // Increase worker's coin balance
      await usersCollection.updateOne(
        { email: submission.worker_email },
        { $inc: { coins: submission.payable_amount } }
      );

      await buyerTaskCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: -1 } }
      );

      // Update submission status
      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved" } }
      );

      res.send({ message: "Approved and coin added to worker" });
    });

    app.patch("/submissions/reject/:id", async (req, res) => {
      const { id } = req.params;

      const submission = await submissionsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!submission)
        return res.status(404).send({ message: "Submission not found" });

      const task = await buyerTaskCollection.findOne({
        _id: new ObjectId(submission.task_id),
      });

      if (!task) {
        return res.status(404).send({ message: "Task not found" });
      }

      // Increase task's required_workers
      await buyerTaskCollection.updateOne(
        { _id: new ObjectId(submission.task_id) },
        { $inc: { required_workers: 1 } }
      );

      await usersCollection.updateOne(
        { email: task.buyer_email },
        { $inc: { coins: task.payable_amount } }
      );

      // Update submission status
      await submissionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } }
      );

      res.send({ message: "Rejected and required_workers increased" });
    });

    app.post("/withdrawals", async (req, res) => {
      try {
        const {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
          withdraw_date,
          status,
        } = req.body;

        if (!withdrawal_coin || withdrawal_coin < 200) {
          return res
            .status(400)
            .send({ error: "Minimum 200 coins required for withdrawal" });
        }

        const user = await usersCollection.findOne({ email: worker_email });
        if (!user) {
          return res.status(404).send({ error: "User not found" });
        }

        if (user.coins < withdrawal_coin) {
          return res
            .status(400)
            .send({ error: "Not enough coins to withdraw" });
        }

        const withdrawalData = {
          worker_email,
          worker_name,
          withdrawal_coin,
          withdrawal_amount,
          payment_system,
          account_number,
          withdraw_date: new Date(withdraw_date),
          status: status || "pending",
        };

        const result = await withdrawalsCollection.insertOne(withdrawalData);

        const updateResult = await usersCollection.updateOne(
          { email: worker_email },
          { $inc: { coins: -withdrawal_coin } }
        );

        res.status(201).send({
          success: true,
          message: "Withdrawal request submitted and coins deducted",
          data: result,
        });
      } catch (error) {
        console.error("Withdrawal Error:", error);
        res.status(500).send({ error: "Failed to submit withdrawal request" });
      }
    });

    app.get("/submissions", async (req, res) => {
      const workerEmail = req.query.workerEmail;

      if (!workerEmail) {
        return res.status(400).send({ message: "Worker email required" });
      }

      try {
        const submissions = await submissionsCollection
          .find({ worker_email: workerEmail })
          .toArray();

        res.send(submissions);
      } catch (error) {
        res.status(500).send({ message: "Error fetching submissions", error });
      }
    });

    app.get("/users/coin/:email", async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ coins: user?.coins || 0 });
    });
    app.post("/submissions", async (req, res) => {
      try {
        const submission = req.body;
        if (
          !submission.task_id ||
          !submission.worker_email ||
          !submission.submission_details
        ) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        const result = await submissionsCollection.insertOne(submission);
        res.send({ insertedId: result.insertedId });
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .send({ message: "Failed to save submission", error: err.message });
      }
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
      try {
        const id = req.params.id;
        const task = await buyerTaskCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!task) {
          return res.status(404).send({ message: "Task not found" });
        }

        res.send(task);
      } catch (err) {
        res
          .status(400)
          .send({ message: "Invalid task ID format", error: err.message });
      }
    });

    app.get("/tasks", async (req, res) => {
      const result = await buyerTaskCollection.find().toArray();
      res.send(result);
    });

    app.patch("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const { task_title, task_detail, submission_info } = req.body;

      const updated = await buyerTaskCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            task_title,
            task_detail,
            submission_info,
          },
        }
      );

      res.send(updated);
    });

    app.delete("/tasks/:id", async (req, res) => {
      const id = req.params.id;
      const { userEmail, status, refundAmount } = req.body;

      const task = await buyerTaskCollection.findOne({ _id: new ObjectId(id) });

      if (!task) return res.status(404).send({ error: "Task not found" });

      const result = await buyerTaskCollection.deleteOne({
        _id: new ObjectId(id),
      });

      if (status !== "completed") {
        await usersCollection.updateOne(
          { email: userEmail },
          { $inc: { coins: refundAmount } }
        );
      }

      res.send({ success: true });
    });

    app.get("/tasks/user/:email", async (req, res) => {
      const email = req.params.email;
      const tasks = await buyerTaskCollection
        .find({ buyer_email: email })
        .toArray();
      res.send(tasks);
    });

    app.post("/tasks", async (req, res) => {
      const task = req.body;

      try {
        const result = await buyerTaskCollection.insertOne(task);
        res.send({ insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ error: "Failed to add task" });
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

      try {
        const result = await usersCollection.updateOne(
          { email },
          { $inc: { coins: -coins } }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: "Failed to reduce coins" });
      }
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "Access denied" });
      }
      const user = await usersCollection.findOne({ email });
      res.send(user);
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

    app.get("/best-workers", async (req, res) => {
      const topWorkers = await usersCollection
        .find({ role: "worker" })
        .sort({ coins: -1 })
        .limit(6)
        .project({ name: 1, photoURL: 1, coins: 1, _id: 0 })
        .toArray();

      res.send(topWorkers);
    });

    app.get("/admin/tasks", async (req, res) => {
      const tasks = await buyerTaskCollection.find().toArray();
      res.send(tasks);
    });
    app.delete("/admin/tasks/:id", async (req, res) => {
      const taskId = req.params.id;
      await buyerTaskCollection.deleteOne({ _id: new ObjectId(taskId) });
      res.send({ success: true });
    });

    app.delete("/admin/users/:id", async (req, res) => {
      const id = req.params.id;
      await usersCollection.deleteOne({ _id: new ObjectId(id) });
      res.send({ success: true });
    });
    app.patch("/admin/users/:id", async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role } }
      );
      res.send({ success: true });
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
