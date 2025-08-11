import axios from "axios";
import fs from "fs";

function getRaspberryPiSerial(): string | null {
    try {
        const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
        const match = cpuInfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
        return match?.[1] ?? null; // ? null if undefined
    } catch (err) {
        console.error("Error reading CPU serial:", err);
        return null;
    }
}

const serial = getRaspberryPiSerial();

// Function that calls the webservice
async function pollService() {
    try {
        // const response = await axios.get("https://example.com/api/status");
        // console.log("Response:", response.data);
        console.log(serial)
    } catch (error) {
        console.error("Error calling webservice:", error);
    }
}

// Call immediately on startup
pollService();

// Repeat every 10 minutes (600_000 ms)
setInterval(pollService,  15 * 1000);





