/**
 * Vue SFC 类型声明（供 tsc / 编辑器识别 .vue 模块）。
 * vue-tsc 原生支持 .vue，这里主要是为编辑器与纯 tsc 场景兜底。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
