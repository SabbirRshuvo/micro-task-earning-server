# Micro Task Earning (Server Side)
This is the **server-side code** for the Micro Task Earning platform — a dynamic task-based earning system where Buyers can post micro-tasks and Workers can complete them to earn coins. Admin can manage users and monitor activity.

###  Live Site:
 (https://micro-task-earning-56ea3.web.app/login)
###  Admin Access:
- **Email:** sabbirkhan@gmail.com
- **Password:** sabbir12

---

##  Server Side Tech Stack

- **Express.js**
- **MongoDB**
- **Stripe (Payment Gateway)**
- **JWT (JSON Web Token)**
- **Cookie Parser**
- **CORS**
- **dotenv**
- **Morgan**

---

##  API Features (Backend)


1. **JWT-based authentication** just for sign in and logout.
2. **Role-based access control** for Admin, Buyer, and Worker.
3. **Coin wallet system** for users with live coin update.
4. **Micro-task creation and management** for Buyers.
5. **Task submission and approval flow** for Workers and Buyers.
6. **Coins transferred automatically** between Buyer and Worker on approval.
7. **Stripe integration** for real payment processing.
8. **Worker request rejection** returns coins and updates task availability.
9. **Admin control panel**: monitor users, submissions, and task data.
10. **Secure API routes** using JWT, cookies, and environmental configs.
