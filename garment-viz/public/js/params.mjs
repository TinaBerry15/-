// 服のシルエットを決めるパラメータの定義。
// ブラウザ側 (UI生成) とサーバ側 (Claude に渡すツールスキーマ) の両方から読む、
// 唯一の真実の置き場所。ここを増やせば UI もスキーマも自動で追従する。

export const PARAM_DEFS = [
  // --- 全体のシルエット ---
  { key: 'length', label: '丈', group: '全体',
    min: 0, max: 1, def: 0.45, low: 'クロップ', high: 'マキシ',
    desc: '0=へそが見える丈, 0.5=腰が隠れる丈, 1=くるぶしまでのマキシ丈' },
  { key: 'looseness', label: 'ゆとり', group: '全体',
    min: 0, max: 1, def: 0.40, low: 'ぴったり', high: 'オーバーサイズ',
    desc: '身幅の余裕。0=体に沿う, 1=何サイズも大きいオーバーサイズ' },
  { key: 'hemFlare', label: '裾の広がり', group: '全体',
    min: 0, max: 1, def: 0.20, low: 'ストレート', high: 'Aライン',
    desc: '0=裾まで真っ直ぐ, 1=裾が大きく広がるAライン・フレア' },
  { key: 'waist', label: 'ウエスト', group: '全体',
    min: -1, max: 1, def: 0.0, low: '出す', high: '絞る',
    desc: 'マイナス=ウエストを出して寸胴に, 0=何もしない, プラス=ウエストを絞る' },

  // --- 肩と袖 ---
  { key: 'shoulderDrop', label: '肩の落ち', group: '肩と袖',
    min: 0, max: 1, def: 0.25, low: 'ジャスト', high: 'ドロップ',
    desc: '0=肩線が肩の位置ぴったり, 1=肩線が腕まで落ちたドロップショルダー' },
  { key: 'sleeveLength', label: '袖丈', group: '肩と袖',
    min: 0, max: 1, def: 0.80, low: 'ノースリーブ', high: '長袖',
    desc: '0=袖なし, 0.3=半袖, 0.6=七分袖, 1=手首までの長袖' },
  { key: 'sleeveWidth', label: '袖の太さ', group: '肩と袖',
    min: 0, max: 1, def: 0.35, low: '細い', high: '太い',
    desc: '0=腕に沿う細い袖, 1=ゆったりした太い袖' },
  { key: 'sleeveDroop', label: '袖の落ち感', group: '肩と袖',
    min: 0, max: 1, def: 0.45, low: '張る', high: 'だらっと',
    desc: '0=袖が横に張り出す, 1=重力で下にだらっと落ちる' },

  // --- 襟 ---
  { key: 'neckWidth', label: '襟の広さ', group: '襟',
    min: 0, max: 1, def: 0.30, low: '詰まる', high: 'ワイド',
    desc: '0=首に詰まったハイネック気味, 1=肩に近いワイドネック・ボートネック' },
  { key: 'neckDepth', label: '襟の深さ', group: '襟',
    min: 0, max: 1, def: 0.25, low: '浅い', high: '深い',
    desc: '0=浅いクルーネック, 1=胸元まで開いた深いVネック' },

  // --- 素材感 ---
  { key: 'stiffness', label: '生地のハリ', group: '素材感',
    min: 0, max: 1, def: 0.35, low: 'とろみ', high: '硬い',
    desc: '0=体に沿って落ちるとろみ素材, 1=形が自立する硬い素材 (デニム・コート地)' },
];

export const DEFAULT_COLOR = '#c8c3bb';

export function defaults() {
  const p = {};
  for (const d of PARAM_DEFS) p[d.key] = d.def;
  p.color = DEFAULT_COLOR;
  return p;
}

export function clampParams(input) {
  const out = defaults();
  if (!input || typeof input !== 'object') return out;
  for (const d of PARAM_DEFS) {
    const v = Number(input[d.key]);
    if (Number.isFinite(v)) out[d.key] = Math.min(d.max, Math.max(d.min, v));
  }
  if (typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)) {
    out.color = input.color;
  }
  return out;
}

// Claude に渡す strict ツールのための JSON Schema。
// strict:true は additionalProperties:false と全項目 required を要求する。
export function toolInputSchema() {
  const properties = {};
  for (const d of PARAM_DEFS) {
    properties[d.key] = {
      type: 'number',
      description: `${d.label} (${d.min}=${d.low}, ${d.max}=${d.high}). ${d.desc}`,
    };
  }
  properties.color = {
    type: 'string',
    description: '生地の色。#rrggbb 形式の16進カラー。指定が読み取れなければ現在の色をそのまま返す。',
  };
  properties.note = {
    type: 'string',
    description: '何をどう解釈したかの、ユーザーへの一行の日本語メモ。',
  };
  return {
    type: 'object',
    properties,
    required: [...PARAM_DEFS.map((d) => d.key), 'color', 'note'],
    additionalProperties: false,
  };
}
