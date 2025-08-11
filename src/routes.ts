import axios from "axios";

// Function that calls the webservice
async function pollService() {
    try {
        const response = await axios.get("https://example.com/api/status");
        console.log("Response:", response.data);
    } catch (error) {
        console.error("Error calling webservice:", error);
    }
}

// Call immediately on startup
pollService();

// Repeat every 10 minutes (600_000 ms)
setInterval(pollService, 10 * 60 * 1000);