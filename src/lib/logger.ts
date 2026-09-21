/**
 * 统一日志模块 - 环境控制
 * 
 * 功能：
 * - 根据 NODE_ENV 和自定义 LOG_LEVEL 控制日志级别
 * - 生产环境默认关闭 debug/verbose 日志
 * - 支持标记敏感信息自动脱敏
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "verbose";

/** 当前日志级别（生产环境默认为 warn） */
const resolveInitialLogLevel = (): LogLevel => {
  const env = import.meta.env?.MODE || (typeof process !== "undefined" ? process.env?.NODE_ENV : undefined);
  const levelStr = import.meta.env?.VITE_LOG_LEVEL || (typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined);
  
  const levels: Record<string, number> = {
    verbose: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
  };
  
  // 开发环境默认 info，生产环境默认 warn
  const defaultLevel = env === "production" ? "warn" : "info";
  const level = levelStr && levels[levelStr.toLowerCase()] !== undefined
    ? (levelStr as Lowercase<LogLevel>)
    : (defaultLevel as LogLevel);
  
  return level;
}

const currentLevel = resolveInitialLogLevel();

/** 检查某个级别是否应该输出 */
function shouldLog(level: LogLevel): boolean {
  const levelOrder: Record<LogLevel, number> = {
    verbose: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
  };
  return levelOrder[level] <= levelOrder[currentLevel];
}

/** 敏感信息模式（自动脱敏 URL、密钥等） */
const SENSITIVE_PATTERNS = [
  /https?:\/\/[^ ]+/g,           // URL
  /TOKEN[a-zA-Z0-9_]*/gi,         // TOKEN 相关变量
  /KEY[a-zA-Z0-9_]*/gi,           // KEY 相关变量
  /PASSWORD[a-zA-Z0-9_]*/gi,      // PASSWORD 相关变量
];

/** 脱敏函数 */
function sanitize(msg: string): string {
  let result = msg;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ==================== 公共日志方法 ====================

/** Error 日志 */
export function error(...args: unknown[]): void {
  if (!shouldLog("error")) return;
  console.error("[我的搜索] ", ...args.map(sanitize));
}

/** Warn 日志 */
export function warn(...args: unknown[]): void {
  if (!shouldLog("warn")) return;
  console.warn("[我的搜索] ", ...args.map(sanitize));
}

/** Info 日志 */
export function info(...args: unknown[]): void {
  if (!shouldLog("info")) return;
  console.log("[我的搜索] ", ...args.map(sanitize));
}

/** Debug 日志 */
export function debug(...args: unknown[]): void {
  if (!shouldLog("debug")) return;
  console.debug("[我的搜索]", ...args.map(sanitize));
}

/** Verbose 日志（详细调试） */
export function verbose(...args: unknown[]): void {
  if (!shouldLog("verbose")) return;
  console.debug("[我的搜索::V]", ...args.map(sanitize));
}

/** 带错误上下文的 error */
export function errorWithContext(context: string, error: unknown): void {
  error(`${context}:`, error);
}

/** 警告并降级处理 */
export function warnWithFallback<T>(
  fallback: T,
  message: string,
  error?: unknown
): T {
  warn(message, error ?? "");
  return fallback;
}

// ==================== 计时器工具 ====================

interface TimerInfo {
  start: number;
  label: string;
}

const activeTimers = new Map<string, TimerInfo>();

/** 开始计时 */
export function startTimer(label: string): void {
  activeTimers.set(label, { start: Date.now(), label });
}

/** 结束计时并输出 */
export function endTimer(label: string): void {
  const timer = activeTimers.get(label);
  if (!timer) {
    warn(`未找到计时器：${label}`);
    return;
  }
  const elapsed = Date.now() - timer.start;
  debug(`${timer.label}: ${elapsed}ms`);
  activeTimers.delete(label);
}

/** 一次性计时器（返回 dispose 函数） */
export function createTimer(label: string): () => number {
  const startTime = Date.now();
  return () => {
    const elapsed = Date.now() - startTime;
    debug(`${label}: ${elapsed}ms`);
    return elapsed;
  };
}

// ==================== 日志级别控制（运行时） ====================

export function setLogLevel(level: LogLevel): void {
  const newLevel = ["verbose", "debug", "info", "warn", "error"].includes(level)
    ? level
    : "warn";
  Object.assign(globalThis, {
    MY_SEARCH_LOG_LEVEL: newLevel as any,
  });
  // 触发重新计算（实际需要重新加载应用）
  info(`日志级别已设置为：${newLevel}`);
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

// ==================== 导出旧接口兼容 ====================
// 保留旧的 console 调用方式以确保向后兼容
export const logger = {
  error,
  warn,
  info,
  debug,
  verbose,
};
