import * as fs from "fs"
import axios from "axios"
import { log } from "./log"

const url = "https://web.whatsapp.com"

const getMainScript = async () => {
    const headers = {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": `"Not A(Brand";v="24", "Chromium";v="110"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": `"Windows"`,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "referer": url,
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    }

    log("info", "fetching main page")
    const main = await axios.get(url, { headers })

    const appScriptUrl = /<script defer="defer" src="(?<url>\/app.[a-z0-9]*\.js)"><\/script>/g.exec(main.data)
    if (!appScriptUrl?.groups) throw new Error("couldnt find app script")

    log("info", `fetching app script ("${appScriptUrl.groups["url"]}")`)
    const appScript = await axios.get(`${url}${appScriptUrl.groups["url"]}`, { headers })

    fs.writeFileSync("app.js", appScript.data)

    log("info", `writing app script to file ("app.js")`)
}

getMainScript()