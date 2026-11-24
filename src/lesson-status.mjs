// 经验状态的唯一定义处（ADR-0007 / P0-2）：状态只存一列，读也只认这一处。
//
// 五种状态写进 knowledge_lessons.verification_status 这一列：
//   unverified  有可追证据、等人确认
//   inferred    追不到证据，只能算推断
//   verified    人确认过（系统不会自动写）
//   disputed    同一作用域出现不同对策，等人裁决
//   superseded  裁决输掉，保留但不作为建议
//
// 争议的裁决过程仍记在 payload.dispute 里（谁和谁争、谁裁的、裁决到哪一步），
// 但「当前是什么状态」只看这一列：同一概念不存两处。
export const LESSON_STATUSES = Object.freeze(['unverified', 'inferred', 'verified', 'disputed', 'superseded']);

/** 状态徽章文案：面板、检索结果、候选信号共用一套中文。 */
export const LESSON_STATUS_LABELS = Object.freeze({
  unverified: '待验证',
  inferred: '推断',
  verified: '已验证',
  disputed: '争议',
  superseded: '已被取代'
});

/** 新写一条经验时允许的状态：系统不会替人把经验标成已验证。 */
export const CREATABLE_LESSON_STATUSES = Object.freeze(['unverified', 'inferred', 'disputed']);

// 缺状态时的兜底：没有任何证据的结论只能是推断，读不回状态时也取最保守的那个。
const DEFAULT_LESSON_STATUS = 'inferred';

export const isLessonStatus = (value) => LESSON_STATUSES.includes(value);

/**
 * 读一条经验的状态。只认一个字段顺序：列投影出来的 verificationStatus，其次 status。
 * 未知取值不吞掉（原样返回字符串），方便排查；空值退到 inferred。
 */
export function lessonStatusOf(lesson) {
  const raw = typeof lesson === 'string' ? lesson : (lesson?.verificationStatus ?? lesson?.status);
  if (isLessonStatus(raw)) return raw;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text || DEFAULT_LESSON_STATUS;
}

/** 状态徽章文案：未知状态原样显示，不假装它是已知状态。 */
export function lessonStatusLabel(status) {
  return LESSON_STATUS_LABELS[status] ?? String(status ?? '未知');
}
