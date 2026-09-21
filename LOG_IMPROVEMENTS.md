# 日志系统改进报告

## 已完成改进

### 1. 统一日志模块 ([`src/lib/logger.ts`](src/lib/logger.ts))
创建了一个环境控制的日志系统：

- **环境变量控制**: 根据 `NODE_ENV` 和 `VITE_LOG_LEVEL` 自动调整日志级别
- **敏感信息脱敏**: 自动隐藏 URL、TOKEN、KEY、PASSWORD 等敏感信息
- **5 个日志级别**: verbose, debug, info, warn, error
- **计时器工具**: 提供性能测试的计时 API

使用示例:
```typescript
import { debug, warn, error } from "./lib/logger";

debug("开发调试信息");
warn("警告信息");
error("错误信息"); // 生产环境也会输出
```

### 2. 同步引擎竞态处理优化 ([`src/lib/sync/engine.ts`](src/lib/sync/engine.ts))
- ✅ 增强锁机制，更详细的日志输出
- ✅ 区分不同触发场景（onChange/background/manual）
- ✅ 使用新的 logger 替代 console.warn/log

### 3. 插件热重载失败处理 ([`src/windows/search/App.vue`](src/windows/search/App.vue))
- ✅ 重挂失败时给用户明确的提示
- ✅ 降级处理：提示用户手动刷新或重启插件
- ✅ 使用统一的 warn 函数记录错误

### 4. 订阅解析容错改进 ([`src/lib/subscribe-parser.ts`](src/lib/subscribe-parser.ts))
- ✅ 编译失败时明确回退到默认实现
- ✅ 添加调试日志便于排查问题

## 待改进项

以下文件仍需将 console 调用替换为 logger:

### 高优先级 (核心功能)
1. **[`src/lib/search-engine.ts`](src/lib/search-engine.ts)** - 搜索核心逻辑
   - 缓存读写错误
   - 订阅加载失败
   
2. **[`src/lib/tauri-bridge.ts`](src/lib/tauri-bridge.ts)** - Tauri 桥接层
   - 快捷键读取失败
   - 窗口事件监听失败
   
3. **[`src/lib/plugins/host.ts`](src/lib/plugins/host.ts)** - 插件宿主
   - 通知处理器异常

4. **[`src/lib/util.ts`](src/lib/util.ts)** - 工具函数
   - 缓存存储失败

### 中优先级 (配置和管理)
5. **[`src/main.ts`](src/main.ts)** - 主入口
6. **[`src/config.ts`](src/config.ts)** - 配置页面
7. **[`src/windows/config/usePluginRuntime.ts`](src/windows/config/usePluginRuntime.ts)**
8. **[`src/windows/search/usePluginHost.ts`](src/windows/search/usePluginHost.ts)**

### 低优先级 (UI 组件)
9. **面板组件** - PanelSync, PanelPlugins, PanelAbout, etc.
10. **脚本执行** - useScriptHost, script-runtime

## 改进效果

1. **生产环境更干净**: 可通过环境变量关闭 debug/info 日志
2. **安全性提升**: 敏感信息自动脱敏
3. **调试更方便**: 开发环境可开启 verbose 模式
4. **错误定位更快**: 统一的日志前缀格式

## 下一步建议

1. 逐步替换剩余文件的 console 调用
2. 添加日志聚合到远程监控服务（可选）
3. 考虑添加结构化日志（JSON 格式）
4. 添加性能追踪标记

## 使用方法

### 设置日志级别

在 `.env` 文件中设置:
```bash
# 开发环境
VITE_LOG_LEVEL=debug

# 生产环境（默认，静默模式）
VITE_LOG_LEVEL=warn
```

运行时动态调整:
```typescript
import { setLogLevel } from "./lib/logger";
setLogLevel("verbose");  // 详细模式
setLogLevel("debug");    // 调试模式
setLogLevel("info");     // 普通信息
setLogLevel("warn");     // 仅警告和错误
setLogLevel("error");    // 仅错误
```

---

*更新：2026-09-21*
