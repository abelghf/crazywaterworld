import { isRecord } from "./login-settings";

export type ItemAttr = {
  name: string;
  display: string;
  rating: number;
  letter: string;
};

export type ItemRow = {
  uid: string;
  id: string;
  kind: "equip" | "badge";
  name: string;
  type: string;
  career: string;
  quality: string;
  qualityIndex: number;
  level: number;
  maxLevel: number;
  star: number;
  refineLv: number;
  slots: number;
  baseAttrs: ItemAttr[];
  attrs: ItemAttr[];
  pending: ItemAttr[];
  rating: number;
  ratingLetter: string;
  wornBy: string;
  icon: string;
  rerollable: boolean;
};

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function counts(value: unknown) {
  const table: Record<string, number> = {};
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item)) table[key] = item;
    }
  }
  return table;
}

function parseAttr(value: unknown): ItemAttr {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.display !== "string"
  )
    throw Error("装备属性格式无效");
  return {
    name: value.name,
    display: value.display,
    rating: number(value.rating),
    letter: text(value.letter),
  };
}

function parseAttrList(value: unknown) {
  if (!Array.isArray(value)) throw Error("装备属性列表格式无效");
  return value.map(parseAttr);
}

function parseRow(value: unknown): ItemRow {
  if (
    !isRecord(value) ||
    typeof value.uid !== "string" ||
    !/^[1-9]\d{0,18}$/.test(value.uid) ||
    typeof value.name !== "string" ||
    (value.kind !== "equip" && value.kind !== "badge")
  )
    throw Error("装备条目格式无效");
  if (
    typeof value.icon !== "string" ||
    (value.icon && !value.icon.startsWith("/api/art/icon/"))
  )
    throw Error("装备图标格式无效");
  return {
    uid: value.uid,
    id: text(value.id),
    kind: value.kind,
    name: value.name,
    type: text(value.type),
    career: text(value.career),
    quality: text(value.quality),
    qualityIndex: number(value.qualityIndex),
    level: number(value.level),
    maxLevel: number(value.maxLevel),
    star: number(value.star),
    refineLv: number(value.refineLv),
    slots: number(value.slots),
    baseAttrs: parseAttrList(value.baseAttrs),
    attrs: parseAttrList(value.attrs),
    pending: parseAttrList(value.pending),
    rating: number(value.rating),
    ratingLetter: text(value.ratingLetter),
    wornBy: text(value.wornBy),
    icon: value.icon,
    rerollable: value.rerollable === true,
  };
}

export function parseItems(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.rows))
    throw Error("装备列表格式无效");
  const rows = data.rows.map(parseRow);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.kind}:${row.uid}`;
    if (seen.has(key)) throw Error("装备列表存在重复条目");
    seen.add(key);
  }
  const materials: Record<string, number> = {};
  if (isRecord(data.materials)) {
    for (const [key, value] of Object.entries(data.materials)) {
      if (typeof value === "number" && Number.isFinite(value))
        materials[key] = value;
    }
  }
  return { rows, materials, hint: text(data.hint) };
}

export function parseReroll(data: unknown) {
  if (!isRecord(data)) throw Error("洗炼结果格式无效");
  return {
    equip: parseRow(data.equip),
    materials: isRecord(data.materials)
      ? {
          before: counts(data.materials.before),
          after: counts(data.materials.after),
        }
      : null,
  };
}

export function parseRerollDecision(data: unknown) {
  if (!isRecord(data)) throw Error("洗炼结果格式无效");
  return { equip: parseRow(data.equip) };
}
