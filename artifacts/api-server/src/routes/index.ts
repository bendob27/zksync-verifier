import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import verifyRouter from "./verify";
import sheetsRouter from "./sheets";
import ocrRouter from "./ocr";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(verifyRouter);
router.use(sheetsRouter);
router.use(ocrRouter);

export default router;
