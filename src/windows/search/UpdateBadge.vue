<script setup lang="ts">
/**
 * 更新就绪角标：贴叶子 logo **右下角**的一个**丰满的红色向上箭头**（无圆底）。
 *
 * 设计口径（本次改版）：
 * - 更新**后台静默下载**，下载过程不打扰用户；只有「下载完成、可以安装」时
 *   才由父层（SearchBox）用 `v-if="update.isDownloaded()"` 显示本角标。
 * - 造型：**只有箭头本体**（用户口径：不要圆底），但做得**丰满厚实**——
 *   宽箭头 + 粗箭杆，并用同色圆角描边把折角磨圆，看起来是一块实心图形
 *   而不是细线条；再给一点向下投影保留「贴上去」的实体感（样式见 style.css）。
 * - `pointer-events: none`：不抢事件——点徽标区域等同于点叶子（父层据此
 *   触发安装），所以这里不挂任何点击处理器。
 */
</script>

<template>
  <div id="updateBadge" class="update-badge" aria-hidden="true">
    <!-- 自绘的「胖箭头」路径（24 视图框内留 2 单位余量）：
         箭头顶点 (12,2) → 两翼 (2,12)/(22,12) → 粗箭杆 (7.4~16.6, 到 y=22)。
         填充 + 同色圆角描边（stroke-linejoin:round）= 折角磨圆、形体更饱满。 -->
    <svg class="update-badge-arrow" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2 L22 12 H16.6 V22 H7.4 V12 H2 Z"
        fill="#f5222d"
        stroke="#f5222d"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  </div>
</template>
