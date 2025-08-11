import axios from "axios";
import fs from "fs";
import path from "path";

function getMacAddress(): string  {
    try {
        const netPath = "/sys/class/net";
        const interfaces = fs.readdirSync(netPath);

        for (const iface of interfaces) {
            if (iface === "lo") continue; // skip loopback
            const addressPath = path.join(netPath, iface, "address");
            if (fs.existsSync(addressPath)) {
                const mac = fs.readFileSync(addressPath, "utf8").trim();
                if (mac && mac !== "00:00:00:00:00:00") {
                    return mac;
                }
            }
        }
        return "";
    } catch (err) {
        console.error("Error reading MAC address:", err);
        return "";
    }
}

function getRaspberryPiSerial(): string | null {
    try {
        const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
        const match = cpuInfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
        const mac = getMacAddress();
        const idx =  mac + (match?.[1] ?? "");
        return idx;
        //return match?.[1] ?? null; // ? null if undefined
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





