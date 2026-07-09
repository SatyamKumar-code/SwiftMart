import type { Request, Response } from "express";
import { getEnv } from "../lib/env";
import { checkoutSessions, orderItems, orders } from "../db/schema";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { Webhook } from "standardwebhooks";

function headerString(headers: Request["headers"], name: string) {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function checkoutSessionidFromMetadata(order: Record<string, unknown>) {
    const metadata = order.metadata;
    if (!metadata || typeof metadata !== "object") return undefined;
    const sessionId = (metadata as Record<string, unknown>).checkout_session_id;
    return typeof sessionId === "string" ? sessionId : undefined;
}

async function alreadyPaid(polarOrderId?: string, checkoutId?: string) {
    if (polarOrderId) {
        const [row] = await db
            .select()
            .from(orders)
            .where(eq(orders.polarOrderId, polarOrderId))
            .limit(1);
        if (row?.status === "paid") return true;
    }
    if (checkoutId) {
        const [row] = await db
            .select()
            .from(orders)
            .where(eq(orders.polarOrderId, checkoutId))
            .limit(1);
        if (row?.status === "paid") return true;
    }
    return false;
}

async function fulfillCheckoutSession(
    sessionId: string,
    polarOrderId?: string | undefined,
    checkoutId?: string | undefined
) {
    return await db.transaction(async (tx) => {
        const [session] = await tx
            .select()
            .from(checkoutSessions)
            .where(eq(checkoutSessions.id, sessionId))
            .for("update")

        if (!session) {
            return false;
        }

        const [order] = await tx
            .insert(orders)
            .values({
                userId: session.userId,
                status: "paid",
                totalCents: session.totalCents,
                polarCheckoutId: checkoutId ?? session.polarCheckoutId ?? null,
                ...(polarOrderId ? { polarOrderId } : {}),
            })
            .returning();

        if (session.lines.length) {
            await tx.insert(orderItems).values(
                session.lines.map((line) => ({
                    orderId: order.id,
                    productId: line.productId,
                    quantity: line.quantity,
                    unitPriceCents: line.unitPriceCents,
                })),
            );
        }

        await tx.delete(checkoutSessions).where(eq(checkoutSessions.id, sessionId));

        return true;
    })
}

export async function polarWebhookHandler(req: Request, res: Response) {

    const env = getEnv();
    try {
        if (!env.POLAR_WEBHOOK_SECRET) {
            res.status(503).send("Polar webhook not configured");
            return;
        }

        const raw = req.body instanceof Buffer ? req.body : Buffer.from(req.body);
        const wh = new Webhook(Buffer.from(env.POLAR_WEBHOOK_SECRET, "utf-8").toString("base64"));

        const id = headerString(req.headers, "Webhook-Id");
        const ts = headerString(req.headers, "Webhook-Timestamp");
        const sig = headerString(req.headers, "Webhook-Signature");

        if (!id || !ts || !sig) {
            res.status(400).send("Missing webhook headers");
            return;
        }

        wh.verify(raw, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig });

        const event = JSON.parse(raw.toString("utf-8")) as {
            type: string;
            data: Record<string, unknown>;
        };

        if (event.type === "order.paid" && event.data) {
            const data = event.data;
            const polarOrderId = typeof data.id === "string" ? data.id : undefined;
            const checkoutId = typeof data.checkout_id === "string" ? data.checkout_id : undefined;

            if (await alreadyPaid(polarOrderId, checkoutId)) {
                res.json({ ok: true, duplicate: true });
                return;
            }

            const sessionId = checkoutSessionidFromMetadata(data);

            if (sessionId) {
                const ok = await fulfillCheckoutSession(sessionId, polarOrderId, checkoutId);

                if (ok) {
                    res.json({ ok: true });
                    return;
                }

                if (await alreadyPaid(polarOrderId, checkoutId)) {
                    res.json({ ok: true, duplicate: true });
                    return;
                }

                console.error("Polar order.paid: could not fulfill checkout session", {
                    sessionId,
                    checkoutId,
                });

                res.status(500).json({ error: "Checkout fulfillment failed" });
                return;
            }
        }

        res.json({ ok: true });

    } catch (error) {
        console.error("Polar webhook error:", error);
        res.status(400).json({ error: "Invalid webhook" });
    }

}