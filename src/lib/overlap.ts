/**
 * 重叠匹配度 v1.1
 * @author: zhuangjie
 * 移植自 string-overlap-matching-degree 仓库（ES Module 化）
 */

/** 排序方向 */
export type OverlapSortOrder = "desc" | "asc";

/** 重叠块表：键为「块长度」，值为该长度的所有匹配块 */
export type OverlapBlocks = Record<string, string[]>;

/** 权重表：主题 -> 分值 */
export type TopicWeights = Record<string, number>;

/**
 * 计算对象数组匹配度并排序
 */
export function overlapMatchingDegreeForObjectArray<T>(
  keyword = "",
  objArr: T[] = [],
  fun: (obj: T) => TopicWeights = () => ({}),
  {
    sort = "desc",
    onlyHasScope = false,
    scopeForObjArrContainer,
  }: {
    sort?: OverlapSortOrder;
    onlyHasScope?: boolean;
    scopeForObjArrContainer?: number[];
  } = {}
): T[] {
  const scopeForData = objArr.map((item) => overlapMatchingDegree(keyword, fun(item), sort));
  sortAndSync(scopeForData, objArr, sort);

  if (Array.isArray(scopeForObjArrContainer)) {
    scopeForObjArrContainer.push(...scopeForData);
  }

  return onlyHasScope ? objArr.filter((_, index) => scopeForData[index] !== 0) : objArr;
}

/**
 * 计算匹配度
 * @param keyword 关键词
 * @param topicWeighs 主题权重表，或主题数组（数组时按顺序赋权）
 * @param sort 排序方向
 */
export function overlapMatchingDegree(
  keyword: string,
  topicWeighs: TopicWeights | string[] = {},
  sort: OverlapSortOrder = "desc"
): number {
  let weights: TopicWeights;
  if (Array.isArray(topicWeighs)) {
    const weightMultiplier = sort === "desc" ? 1 : -1;
    weights = Object.fromEntries(
      [...topicWeighs]
        .reverse()
        .map((topic, index) => [topic, (index + 1) * weightMultiplier] as [string, number])
    );
  } else {
    weights = topicWeighs;
  }
  return Object.keys(weights).reduce((totalScore, topic) => {
    const currentScore = weights[topic];
    const overlapLengthBlocksMap = findOverlapBlocks(keyword, topic);
    return (
      totalScore +
      Object.entries(overlapLengthBlocksMap).reduce((sum, [length, blocks]) => {
        return sum + blocks.length * Math.pow(currentScore, Number(length));
      }, 0)
    );
  }, 0);
}

/**
 * 查找重叠匹配块
 */
export function findOverlapBlocks(str1 = "", str2 = ""): OverlapBlocks {
  const alignmentHub: OverlapBlocks = {};
  const str1Len = str1.length;
  const str2Len = str2.length;

  for (let offset = 1 - str2Len; offset < str1Len; offset++) {
    const start = Math.max(0, offset);
    const end = Math.min(str1Len, str2Len + offset);
    const overlapStr1 = str1.slice(start, end);
    const overlapStr2 = str2.slice(start - offset, end - offset);

    const alignmentContent = alignment(overlapStr1, overlapStr2);
    for (const [len, blocks] of Object.entries(alignmentContent)) {
      alignmentHub[len] = alignmentHub[len]
        ? [...new Set([...alignmentHub[len], ...blocks])]
        : blocks;
    }
  }
  return alignmentHub;
}

/** 对齐 */
function alignment(str1 = "", str2 = ""): OverlapBlocks {
  const overlappingBlocks: OverlapBlocks = {};
  let currentBlock = "";

  for (let i = str1.length - 1; i >= 0; i--) {
    if (str1[i] === str2[i]) {
      currentBlock = str1[i] + currentBlock;
    } else if (currentBlock.length > 0) {
      const len = currentBlock.length;
      overlappingBlocks[len] = overlappingBlocks[len] || [];
      if (!overlappingBlocks[len].includes(currentBlock)) {
        overlappingBlocks[len].push(currentBlock);
      }
      currentBlock = "";
    }
  }
  if (currentBlock.length > 0) {
    const len = currentBlock.length;
    overlappingBlocks[len] = overlappingBlocks[len] || [];
    if (!overlappingBlocks[len].includes(currentBlock)) {
      overlappingBlocks[len].push(currentBlock);
    }
  }
  return overlappingBlocks;
}

/** 同步排序 */
function sortAndSync<T>(arr1: number[], arr2: T[], order: OverlapSortOrder = "desc"): void {
  const compare =
    order === "asc" ? (a: number, b: number) => a - b : (a: number, b: number) => b - a;
  arr1
    .map((v, i) => [v, arr2[i]] as [number, T])
    .sort((a, b) => compare(a[0], b[0]))
    .forEach(([v, o], i) => {
      arr1[i] = v;
      arr2[i] = o;
    });
}
