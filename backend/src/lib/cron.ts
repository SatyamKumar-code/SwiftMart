import { CronJob } from "cron";
import http from "node:http";
import https from "node:https";

// every 14 minutes send a GET request to the health endpoint
const job = new CronJob("*/14 * * * *", () => {
    const base = process.env.FRONTEND_URL;
    if (!base) return;
    const url = new URL("/health", base).href;
    const client = url.startsWith("https") ? https : http;

    client
        .get(url, (res) => {
            if (res.statusCode === 200) {
                console.log(`Server Healthy ♥️`);
            } else {
                console.log(`Server Unhealthy 💔: ${res.statusCode}`);
            }
        })
        .on("error", (err) => {
            console.error(`Server Unhealthy 💔: ${err.message}`);
        });
});

export default job;