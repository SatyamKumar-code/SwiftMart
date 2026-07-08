import type { Request, Response } from "express";
import { getEnv } from "../lib/env";
import { verifyWebhook } from "@clerk/express/webhooks";
import { parseRole } from "../lib/roles";
import { users } from "../db/schema";
import { db } from "../db";
import { eq } from "drizzle-orm/sql/expressions/conditions";

export async function clerkWebhookHandler(req: Request, res: Response) {
    const env = getEnv();

    try {
        // webhook verification needs a shared secret; without it we cannot trust incoming POST.
        if (!env.CLERK_WEBHOOK_SECRET) {
            res.status(503).send("Webhook secret is not provided");
            return;
        }

        // verifyWebhook needs the original Express request so it can read the Svix headers and raw body.
        const evt = await verifyWebhook(req as any, { signingSecret: env.CLERK_WEBHOOK_SECRET });

        if(evt.type === "user.created" || evt.type === "user.updated") {
            const u = evt.data;

            const email =
                u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ?? 
                u.email_addresses?.[0]?.email_address;
            
            const displayName = 
                [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || null;

            const role = parseRole(u.public_metadata?.role);

            await db.insert(users).values({
                clerkUserId: u.id,
                email,
                displayName,
                role,
            })
            .onConflictDoUpdate({
                target: users.clerkUserId,
                set: { email, displayName, role, updatedAt: new Date() },
            })
        }

        if(evt.type === "user.deleted") {
            const id = evt.data.id;
            if(id) {
                await db.delete(users).where(eq(users.clerkUserId, id));
            }
        }

        res.json({ok: true});

    } catch (err) {
        // Bad singature, malformed payload, or DB error - do not leak details to the client.
        console.error("Clerk webhook error:", err);
        res.status(400).json({ error: "Invalid webhook"});
    }
}