import { Router } from "express";
import { listProducts, getCategoris, getProductBySlug } from "../controllers/productController";


const router = Router();

router.get("/", listProducts);
router.get("/categories", getCategoris);
router.get("/:slug", getProductBySlug);


export default router;