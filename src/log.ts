type LogLevel = "info" | "warn" | "fatal"
export const log = (level: LogLevel, ...params: any[]) => {
    console.log(`[${level}]`, ...params)
    if (level == "fatal") process.exit(1)
}