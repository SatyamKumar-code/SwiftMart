import type { Request, Response, NextFunction } from "express";
import { getEnv } from "../lib/env";
import z from "zod";
import { getAuth } from "@clerk/express";
import { getLocalUser } from "../lib/users";
import { CheckoutSessionLine, checkoutSessions, products } from "../db/schema";
import { and, eq, inArray } from "drizzle-orm/sql/expressions/conditions";
import { db } from "../db";
import { polarCreateCheckout } from "../lib/polar";

const env = getEnv();

const cartSchema = z.object({
    items: z.array(
        z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().positive(),
        })
    ).min(1)
});

export async function createCheckout(req: Request, res: Response, next: NextFunction) {
    try {
        // only signed-in users can start checkout
        const { userId, isAuthenticated } = getAuth(req);
        if (!isAuthenticated || !userId) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }

        const parsed = cartSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: "Invalid Cart", details: parsed.error.flatten() });
            return;
        }

        // polar access token is required
        if (!env.POLAR_ACCESS_TOKEN) {
            res.status(503).json({ error: "Payment are not configured" });
            return;
        }

        const localUser = await getLocalUser(userId);
        if (!localUser) {
            res.status(503).json({ error: "Account not synced yet" });
            return;
        }

        const ids = parsed.data.items.map((i) => i.productId);

        // load every cart product theat exists, is active, and matches the IDs we asked for.
        const prodRaw = await db
            .select()
            .from(products)
            .where(and(inArray(products.id, ids), eq(products.active, true)));

        if (prodRaw.length !== ids.length) {
            res.status(400).json({ error: "One or more products are invalid or inactive" });
            return;
        }

        const byId = new Map(prodRaw.map((p) => [p.id, p]));
        let totalAmount = 0;
        const lines: CheckoutSessionLine[] = [];

        for (const line of parsed.data.items) {
            const p = byId.get(line.productId)!;
            totalAmount += p.priceCents * line.quantity;
            lines.push({
                productId: p.id,
                quantity: line.quantity,
                unitPriceCents: p.priceCents,
            });
        }

        if (totalAmount <= 10) {
            res.status(400).json({ error: "Total amount must be greater than 10 cents" });
            return;
        }

        const [sessionn] = await db
            .insert(checkoutSessions)
            .values({
                userId: localUser.id,
                lines,
                totalCents: totalAmount,
                currency: "INR",
            })
            .returning();

        const successUrl = `${env.FRONTEND_URL}/checkout/return?checkout_id={CHECKOUT_ID}`;
        const returnUrl = `${env.FRONTEND_URL}/cart`;

        const checkout = await polarCreateCheckout(env, {
            products: [env.POLAR_CHECKOUT_PRODUCT_ID],
            prices: {
                [env.POLAR_CHECKOUT_PRODUCT_ID]: [
                    {
                        amount_type: "fixed",
                        price_amount: totalAmount,
                        price_currency: "INR",
                    }
                ]
            },
            success_url: successUrl,
            return_url: returnUrl,
            external_customer_id: userId,
            metadata: {
                checkout_session_id: sessionn.id,
            }
        })

        await db
            .update(checkoutSessions)
            .set({ polarCheckoutId: checkout.id })
            .where(eq(checkoutSessions.id, sessionn.id));

        res.json({ checkoutUrl: checkout.url });

    } catch (error) {
        next(error);
    }
}