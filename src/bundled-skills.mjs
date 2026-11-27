// 随应用分发固定版本的技能正文；运行时不克隆仓库，也不依赖个人工具目录。
import path from 'node:path';

export const bundledSkillsRoot = path.resolve(import.meta.dirname, '../resources/skills');
export const bundledPstackSkills = path.join(bundledSkillsRoot, 'pstack', 'skills');
export const bundledMattSkills = path.join(bundledSkillsRoot, 'matt', 'skills');

/** 外部路径仍可显式覆盖；展示时标出是否来自随包资源，不把本机扩展冒充内置。 */
export function isBundledSkill(file) {
  if (!file) return false;
  const relative = path.relative(bundledSkillsRoot, path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
