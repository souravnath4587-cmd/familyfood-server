import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4"]);

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  MongoClient,
  ObjectId,
  ServerApiVersion,
  Db,
  Collection,
} from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// ==============================
// Middleware
// ==============================
app.use(cors());
app.use(express.json());

// ==============================
// MongoDB connection (cached across serverless invocations)
// ==============================
const uri = process.env.MONGODB_URI as string;

if (!uri) {
  throw new Error("Missing MONGODB_URI environment variable");
}

interface CartItem {
  productId: ObjectId;
  name: string;
  image: string;
  price: number;
  quantity: number;
}

interface Cart {
  _id?: ObjectId;
  userId: string;
  items: CartItem[];
  createdAt: Date;
  updatedAt: Date;
}

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

let usersCollection: Collection;
let productsCollection: Collection;
let cartCollection: Collection<Cart>;
let ordersCollection: Collection;
let wishlistCollection: Collection;

async function connectToDatabase(): Promise<Db> {
  // Reuse existing connection on warm serverless invocations
  if (cachedDb) {
    return cachedDb;
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
  }

  await cachedClient.connect();

  cachedDb = cachedClient.db("FamilyFood-Auth");

  usersCollection = cachedDb.collection("user");
  productsCollection = cachedDb.collection("products");
  cartCollection = cachedDb.collection<Cart>("cart");
  ordersCollection = cachedDb.collection("orders");
  wishlistCollection = cachedDb.collection("wishlist");

  console.log("MongoDB connected successfully");

  return cachedDb;
}

// Ensure the DB is connected before any route handler runs
app.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("Database connection error:", error);
    return res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

// ==============================
// Health check
// ==============================
app.get("/", (_req: Request, res: Response) => {
  res.send("FamilyFood Backend Server Running");
});

// ==============================
// Profile
// ==============================
app.patch("/api/user/profile", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User ID is required",
      });
    }

    const { name, phone, image } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    const updateData = {
      name: name.trim(),
      ...(phone !== undefined && {
        phone: phone.trim(),
      }),
      ...(image !== undefined && {
        image,
      }),
      updatedAt: new Date(),
    };

    const result = await usersCollection.findOneAndUpdate(
      {
        id: userId,
      },
      {
        $set: updateData,
      },
      {
        returnDocument: "after",
      },
    );

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: result.id,
        name: result.name,
        email: result.email,
        phone: result.phone || "",
        image: result.image || "",
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update profile",
    });
  }
});

app.get("/api/user/profile", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User ID is required",
      });
    }

    // 1. Get User
    const user = await usersCollection.findOne({
      _id: new ObjectId(userId),
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // 2. Get Order Stats
    const totalOrders = await ordersCollection.countDocuments({
      userId,
    });

    const pendingOrders = await ordersCollection.countDocuments({
      userId,
      orderStatus: "pending",
    });

    const completedOrders = await ordersCollection.countDocuments({
      userId,
      orderStatus: "delivered",
    });

    // 3. Get Wishlist
    const wishlist = await wishlistCollection.findOne({
      userId,
    });

    const wishlistItems = wishlist?.items?.length || 0;

    // 4. Response
    return res.status(200).json({
      success: true,

      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        image: user.image || "",
      },

      stats: {
        totalOrders,
        pendingOrders,
        completedOrders,
        wishlistItems,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch profile",
    });
  }
});

// ==============================
// User Wishlist
// ==============================
app.delete(
  "/api/wishlist/:productId",
  async (req: Request<{ productId: string }>, res: Response) => {
    try {
      const userId = req.headers["user-id"] as string;
      const { productId } = req.params;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "User ID is required",
        });
      }

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: "Product ID is required",
        });
      }

      const wishlist = await wishlistCollection.findOne({
        userId,
      });

      if (!wishlist) {
        return res.status(404).json({
          success: false,
          message: "Wishlist not found",
        });
      }

      const updatedItems = wishlist.items.filter(
        (item: string) => item !== productId,
      );

      await wishlistCollection.updateOne(
        { userId },
        {
          $set: {
            items: updatedItems,
          },
        },
      );

      return res.status(200).json({
        success: true,
        message: "Product removed from wishlist",
        items: updatedItems,
      });
    } catch (error) {
      console.error("Remove wishlist error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to remove product from wishlist",
      });
    }
  },
);

app.get("/api/wishlist", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User ID is required",
      });
    }

    const wishlist = await wishlistCollection.findOne({
      userId,
    });

    if (!wishlist) {
      return res.status(200).json({
        success: true,
        items: [],
      });
    }

    const productIds = wishlist.items;

    const products = await productsCollection
      .find({
        _id: {
          $in: productIds.map((id: string) => new ObjectId(id)),
        },
      })
      .toArray();

    return res.status(200).json({
      success: true,
      items: products,
    });
  } catch (error) {
    console.error("Get wishlist error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to get wishlist",
    });
  }
});

app.post("/api/wishlist", async (req: Request, res: Response) => {
  try {
    const { userId, productId } = req.body;

    if (!userId || !productId) {
      return res.status(400).json({
        message: "userId and productId are required",
      });
    }

    const wishlist = await wishlistCollection.findOne({
      userId,
    });

    if (!wishlist) {
      const newWishlist = {
        userId,
        items: [productId],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await wishlistCollection.insertOne(newWishlist);

      return res.status(201).json({
        message: "Product added to wishlist",
        wishlist: newWishlist,
      });
    }

    if (wishlist.items.includes(productId)) {
      return res.status(400).json({
        message: "Product already in wishlist",
      });
    }

    await wishlistCollection.updateOne(
      { userId },
      {
        $push: {
          items: productId,
        },
        $set: {
          updatedAt: new Date(),
        },
      },
    );

    return res.status(200).json({
      message: "Product added to wishlist",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to add product to wishlist",
    });
  }
});

// ==============================
// Admin Revenue
// ==============================
app.get("/api/admin/revenue", async (req: Request, res: Response) => {
  try {
    const { range, startDate, endDate } = req.query;

    const now = new Date();

    let start: Date;
    let end: Date = now;

    switch (range) {
      case "7days": {
        start = new Date(now);
        start.setDate(now.getDate() - 6);
        break;
      }

      case "30days": {
        start = new Date(now);
        start.setDate(now.getDate() - 29);
        break;
      }

      case "6months": {
        start = new Date(now);
        start.setMonth(now.getMonth() - 5);
        start.setDate(1);
        break;
      }

      case "12months": {
        start = new Date(now);
        start.setMonth(now.getMonth() - 11);
        start.setDate(1);
        break;
      }

      case "custom": {
        if (!startDate || !endDate) {
          return res.status(400).json({
            success: false,
            message: "startDate and endDate are required for custom range.",
          });
        }

        start = new Date(startDate as string);

        end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);

        break;
      }

      default: {
        start = new Date(now);
        start.setMonth(now.getMonth() - 11);
        start.setDate(1);
      }
    }

    const revenueData = await ordersCollection
      .aggregate([
        {
          $match: {
            orderStatus: "delivered",

            createdAt: {
              $gte: start,
              $lte: end,
            },
          },
        },

        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
              },
            },

            revenue: {
              $sum: "$totalAmount",
            },

            orders: {
              $sum: 1,
            },
          },
        },

        {
          $sort: {
            _id: 1,
          },
        },

        {
          $project: {
            _id: 0,

            date: "$_id",

            revenue: 1,

            orders: 1,
          },
        },
      ])
      .toArray();

    return res.status(200).json({
      success: true,

      data: revenueData,
    });
  } catch (error) {
    console.error("Revenue analytics error:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to load revenue analytics.",
    });
  }
});

// ==============================
// Admin manage orders
// ==============================
app.get("/api/admin/orders/:orderId", async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;

    if (!ObjectId.isValid(orderId as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID",
      });
    }

    const order = await ordersCollection.findOne({
      _id: new ObjectId(orderId as string),
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order fetched successfully",
      data: order,
    });
  } catch (error) {
    console.error("Get admin order details error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order",
    });
  }
});

app.patch(
  "/api/admin/orders/:orderId/status",
  async (req: Request, res: Response) => {
    try {
      const { orderId } = req.params;
      const { orderStatus } = req.body;

      if (!ObjectId.isValid(orderId as string)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order ID",
        });
      }

      const allowedStatuses = [
        "pending",
        "confirmed",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
      ];

      if (!allowedStatuses.includes(orderStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order status",
        });
      }

      const result = await ordersCollection.updateOne(
        {
          _id: new ObjectId(orderId as string),
        },
        {
          $set: {
            orderStatus,
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }

      const updatedOrder = await ordersCollection.findOne({
        _id: new ObjectId(orderId as string),
      });

      return res.status(200).json({
        success: true,
        message: "Order status updated successfully",
        data: updatedOrder,
      });
    } catch (error) {
      console.error("Update order status error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to update order status",
      });
    }
  },
);

app.get("/api/admin/orders", async (_req: Request, res: Response) => {
  try {
    const orders = await ordersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      message: "All orders fetched successfully",
      data: orders,
    });
  } catch (error) {
    console.error("Get all orders error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

// ==============================
// User orders
// ==============================
app.get("/api/orders/:orderId", async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    if (!ObjectId.isValid(orderId as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order ID",
      });
    }

    const order = await ordersCollection.findOne({
      _id: new ObjectId(orderId as string),
      userId,
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Order fetched successfully",
      data: order,
    });
  } catch (error) {
    console.error("Get single order error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch order",
    });
  }
});

app.get("/api/orders", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    const orders = await ordersCollection
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      message: "Orders fetched successfully",
      data: orders,
    });
  } catch (error) {
    console.error("Get orders error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch orders",
    });
  }
});

app.post("/api/orders", async (req: Request, res: Response) => {
  try {
    const { customer, shippingAddress, deliveryLocation } = req.body;

    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    if (!customer?.fullName) {
      return res.status(400).json({
        success: false,
        message: "Full name is required",
      });
    }

    if (!customer?.phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    if (!shippingAddress?.address) {
      return res.status(400).json({
        success: false,
        message: "Shipping address is required",
      });
    }

    if (!shippingAddress?.city) {
      return res.status(400).json({
        success: false,
        message: "City is required",
      });
    }

    if (
      deliveryLocation !== "inside_feni" &&
      deliveryLocation !== "outside_feni"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid delivery location",
      });
    }

    const cart = await cartCollection.findOne({
      userId,
    });

    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Your cart is empty",
      });
    }

    const orderItems = [];

    let subtotal = 0;

    for (const cartItem of cart.items) {
      if (!ObjectId.isValid(cartItem.productId.toString())) {
        return res.status(400).json({
          success: false,
          message: `Invalid product ID for ${cartItem.name}`,
        });
      }

      const product = await productsCollection.findOne({
        _id: new ObjectId(cartItem.productId.toString()),
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product "${cartItem.name}" is no longer available`,
        });
      }

      const availableStock = product.stockQuantity ?? 0;

      if (availableStock < cartItem.quantity) {
        return res.status(400).json({
          success: false,
          message: `Not enough stock for "${product.name}". Available stock: ${availableStock}`,
        });
      }

      const discountPrice = product.discountPrice ?? 0;

      const finalPrice =
        discountPrice > 0 ? product.price - discountPrice : product.price;

      const itemSubtotal = finalPrice * cartItem.quantity;

      subtotal += itemSubtotal;

      orderItems.push({
        productId: product._id,
        name: product.name,
        image: product.imageUrl || product.image || product.images?.[0] || "",

        price: finalPrice,

        quantity: cartItem.quantity,

        subtotal: itemSubtotal,
      });
    }

    const shippingCost = deliveryLocation === "inside_feni" ? 40 : 100;

    const totalAmount = subtotal + shippingCost;

    const newOrder = {
      userId,

      customer: {
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email || "",
      },

      shippingAddress: {
        address: shippingAddress.address,
        city: shippingAddress.city,
        postalCode: shippingAddress.postalCode || "",
      },

      deliveryLocation,

      items: orderItems,

      subtotal,

      shippingCost,

      totalAmount,

      paymentMethod: "cash_on_delivery",

      paymentStatus: "pending",

      orderStatus: "pending",

      createdAt: new Date(),

      updatedAt: new Date(),
    };

    const orderResult = await ordersCollection.insertOne(newOrder);

    for (const item of orderItems) {
      await productsCollection.updateOne(
        {
          _id: item.productId,
        },
        {
          $inc: {
            stockQuantity: -item.quantity,
          },
          $set: {
            updatedAt: new Date(),
          },
        },
      );
    }

    await cartCollection.deleteOne({
      userId,
    });

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",

      data: {
        _id: orderResult.insertedId,

        ...newOrder,
      },
    });
  } catch (error) {
    console.error("Create order error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to place order",
    });
  }
});

// ==============================
// Cart
// ==============================
app.patch("/api/cart/items/:productId", async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { quantity } = req.body;

    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    if (!ObjectId.isValid(productId as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID",
      });
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1",
      });
    }

    const result = await cartCollection.updateOne(
      {
        userId,
        "items.productId": new ObjectId(productId as string),
      },
      {
        $set: {
          "items.$.quantity": quantity,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Cart item not found",
      });
    }

    const updatedCart = await cartCollection.findOne({
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Cart quantity updated successfully",
      data: updatedCart,
    });
  } catch (error) {
    console.error("Update cart quantity error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update cart quantity",
    });
  }
});

app.delete(
  "/api/cart/items/:productId",
  async (req: Request, res: Response) => {
    try {
      const { productId } = req.params;

      const userId = req.headers["user-id"] as string;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "User is not authenticated",
        });
      }

      if (!ObjectId.isValid(productId as string)) {
        return res.status(400).json({
          success: false,
          message: "Invalid product ID",
        });
      }

      const result = await cartCollection.updateOne(
        {
          userId,
        },
        {
          $pull: {
            items: {
              productId: new ObjectId(productId as string),
            },
          },
          $set: {
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Cart not found",
        });
      }

      const updatedCart = await cartCollection.findOne({
        userId,
      });

      return res.status(200).json({
        success: true,
        message: "Item removed from cart successfully",
        data: updatedCart,
      });
    } catch (error) {
      console.error("Remove cart item error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to remove cart item",
      });
    }
  },
);

app.delete("/api/cart", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    const result = await cartCollection.updateOne(
      {
        userId,
      },
      {
        $set: {
          items: [],
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    const updatedCart = await cartCollection.findOne({
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Cart cleared successfully",
      data: updatedCart,
    });
  } catch (error) {
    console.error("Clear cart error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to clear cart",
    });
  }
});

app.get("/api/cart", async (req: Request, res: Response) => {
  try {
    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    const cart = await cartCollection.findOne({
      userId,
    });

    if (!cart) {
      return res.status(200).json({
        success: true,
        message: "Cart is empty",
        data: {
          userId,
          items: [],
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Cart fetched successfully",
      data: cart,
    });
  } catch (error) {
    console.error("Get cart error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch cart",
    });
  }
});

app.post("/api/cart", async (req: Request, res: Response) => {
  try {
    const { productId, quantity } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Product ID is required",
      });
    }

    if (!quantity || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1",
      });
    }

    const userId = req.headers["user-id"] as string;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User is not authenticated",
      });
    }

    const product = await productsCollection.findOne({
      _id: new ObjectId(productId),
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const cart = await cartCollection.findOne({
      userId,
    });

    if (!cart) {
      const newCart = {
        userId,
        items: [
          {
            productId: product._id,
            name: product.name,
            image: product.imageUrl || product.image || "",
            price:
              product.discountPrice && product.discountPrice > 0
                ? product.price - product.discountPrice
                : product.price,
            quantity,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await cartCollection.insertOne(newCart);

      return res.status(201).json({
        success: true,
        message: "Product added to cart successfully",
        data: {
          _id: result.insertedId,
          ...newCart,
        },
      });
    }

    const existingItem = cart.items.find(
      (item: any) => item.productId.toString() === productId,
    );

    if (existingItem) {
      await cartCollection.updateOne(
        {
          userId,
          "items.productId": new ObjectId(productId),
        },
        {
          $inc: {
            "items.$.quantity": quantity,
          },
          $set: {
            updatedAt: new Date(),
          },
        },
      );
    } else {
      await cartCollection.updateOne(
        {
          userId,
        },
        {
          $push: {
            items: {
              productId: product._id,

              name: product.name,
              image: product.imageUrl || product.image || "",
              price:
                product.discountPrice && product.discountPrice > 0
                  ? product.price - product.discountPrice
                  : product.price,
              quantity,
            },
          },
          $set: {
            updatedAt: new Date(),
          },
        },
      );
    }

    const updatedCart = await cartCollection.findOne({
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Product added to cart successfully",
      data: updatedCart,
    });
  } catch (error) {
    console.error("Add to cart error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to add product to cart",
    });
  }
});

// ==============================
// Admin stats
// ==============================
app.get("/api/admin/stats", async (_req: Request, res: Response) => {
  try {
    const totalProducts = await productsCollection.countDocuments();

    const totalUsers = await usersCollection.countDocuments();

    const totalOrders = await ordersCollection.countDocuments();

    const pendingOrders = await ordersCollection.countDocuments({
      orderStatus: "pending",
    });

    const confirmedOrders = await ordersCollection.countDocuments({
      orderStatus: "confirmed",
    });

    const processingOrders = await ordersCollection.countDocuments({
      orderStatus: "processing",
    });

    const shippedOrders = await ordersCollection.countDocuments({
      orderStatus: "shipped",
    });

    const deliveredOrders = await ordersCollection.countDocuments({
      orderStatus: "delivered",
    });

    const cancelledOrders = await ordersCollection.countDocuments({
      orderStatus: "cancelled",
    });

    const revenueResult = await ordersCollection
      .aggregate([
        {
          $match: {
            orderStatus: "delivered",
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: "$totalAmount",
            },
          },
        },
      ])
      .toArray();

    const totalRevenue = revenueResult[0]?.totalRevenue ?? 0;

    return res.status(200).json({
      success: true,
      data: {
        totalProducts,
        totalUsers,
        totalOrders,

        pendingOrders,
        confirmedOrders,
        processingOrders,
        shippedOrders,
        deliveredOrders,
        cancelledOrders,

        totalRevenue,
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load admin stats.",
    });
  }
});

// ==============================
// Users
// ==============================
app.get("/api/users", async (_req: Request, res: Response) => {
  const result = await usersCollection.find().toArray();
  res.send(result);
});

app.patch("/api/users/:userId/role", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(userId as string)) {
      return res.status(400).json({
        error: "Invalid user id",
      });
    }

    if (!["user", "admin"].includes(role)) {
      return res.status(400).json({
        error: "Invalid role",
      });
    }

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(userId as string) },
      { $set: { role } },
      { returnDocument: "after" },
    );

    if (!result) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Internal Server Error",
    });
  }
});

app.patch(
  "/api/users/:userId/block",
  async (req: Request<{ userId: string }>, res: Response) => {
    try {
      const { userId } = req.params;
      const { isBlocked } = req.body;

      if (!ObjectId.isValid(userId)) {
        return res.status(400).json({
          error: "Invalid user id",
        });
      }

      if (typeof isBlocked !== "boolean") {
        return res.status(400).json({
          error: "isBlocked must be a boolean",
        });
      }

      const result = await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(userId) },
        {
          $set: {
            isBlocked,
          },
        },
        {
          returnDocument: "after",
        },
      );

      if (!result) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      return res.status(200).json(result);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: "Internal Server Error",
      });
    }
  },
);

app.delete("/api/users/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (!ObjectId.isValid(userId as string)) {
      return res.status(400).json({
        error: "Invalid user id",
      });
    }

    const result = await usersCollection.deleteOne({
      _id: new ObjectId(userId as string),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    return res.status(200).json({
      message: "User deleted successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

// ==============================
// Products
// ==============================
app.get("/api/products", async (_req: Request, res: Response) => {
  const products = await productsCollection.find().toArray();
  res.send(products);
});

app.get("/api/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id.",
      });
    }

    const product = await productsCollection.findOne({
      _id: new ObjectId(id as string),
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    res.status(200).json({
      success: true,
      data: product,
    });
  } catch (error) {
    console.error("Get Product Error:", error);

    res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
});

app.patch("/api/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;

    if (!ObjectId.isValid(id as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const filter = {
      _id: new ObjectId(id as string),
    };

    const updateDoc = {
      $set: {
        ...updatedData,
        updatedAt: new Date(),
      },
    };

    const result = await productsCollection.updateOne(filter, updateDoc);

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const updatedProduct = await productsCollection.findOne(filter);

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: updatedProduct,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to update product",
    });
  }
});

app.post("/api/products", async (req: Request, res: Response) => {
  const query = req.body;
  const result = await productsCollection.insertOne(query);
  res.send(result);
});

app.delete("/api/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const filter = {
      _id: new ObjectId(id as string),
    };

    const product = await productsCollection.findOne(filter);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const result = await productsCollection.deleteOne(filter);

    if (result.deletedCount === 0) {
      return res.status(500).json({
        success: false,
        message: "Failed to delete product",
      });
    }

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

// ==============================
// 404 handler
// ==============================
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// ==============================
// Local dev only — Vercel invokes the exported app directly
// and must NOT bind a port itself.
// ==============================
if (process.env.VERCEL !== "1") {
  connectToDatabase()
    .then(() => {
      app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to connect to MongoDB:", error);
      process.exit(1);
    });
}

export default app;
