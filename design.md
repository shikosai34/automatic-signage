# RawBlock Design System

> このドキュメントは **コードを正** とする。トークンの実体は
> [`apps/register/src/index.css`](../apps/register/src/index.css) に定義されており、
> 本書はその意図・使い方・共通コンポーネントの規約をまとめたもの。
> 数値やカラーを変更する場合は **まず `index.css` を編集** し、本書を追従させる。
>
> 最終更新: 2026-07-04（StudioBlank テンプレートから実装準拠の RawBlock へ全面改訂）

## Overview

RawBlock は文化祭運営という「現場で素早く・確実に操作する」ことを最優先した、
ブルータリズム志向のフラットデザインシステム。装飾を排し、**太い枠線・高コントラスト・
等幅フォント**で情報の境界と操作対象を明確にする。角丸なし・ドロップシャドウなしを徹底し、
奥行きは「枠線の太さ」と「前景/背景の反転」だけで表現する。

設計原則:

1. **角丸 0 / 影なし** — `--radius: 0px`。`@layer base` で全要素に `rounded-none shadow-none` を適用。
2. **枠線で構造を示す** — `border-thin(1px) / border-thick(3px) / border-heavy(5px)` の3段階。
3. **反転で状態を示す** — hover/active は背景色と前景色を入れ替える（`bg-primary ⇄ bg-background`）。
4. **等幅＋大文字＋角括弧** — 見出しやラベルは `font-mono uppercase`、モーダル見出しは `[タイトル]` 形式。
5. **単色主義** — 黒(#000)と白(#FFF)が基調。アクセントは1色のみ（情報青/警告など状態色を除く）。

---

## Colors

カラーは CSS 変数で定義し、ライト/ダーク両対応（`.dark` で上書き）。Tailwind からは
`bg-primary` `text-foreground` `border-border` 等のトークン名で参照する。

| トークン | Light | Dark | 用途 |
| :--- | :--- | :--- | :--- |
| `background` | `#FFFFFF` | `#000000` | ページ・カード背景 |
| `foreground` | `#000000` | `#FFFFFF` | 本文・枠線の基準色 |
| `primary` | `#000000` | `#FFFFFF` | 主要アクション（ボタン塗り） |
| `primary-foreground` | `#FFFFFF` | `#000000` | primary 上の文字 |
| `muted` | `#F0F0F0` | `#111111` | 補助背景・注記ボックス |
| `border` | `#000000` | `#FFFFFF` | 全枠線の基準色 |
| `input` | `#F0F0F0` | `#111111` | 入力欄の塗り |
| `destructive` | `#FF0000` | `#FF0000` | 破壊的操作・エラー |

### 状態色（RawBlock system colors）

純度の高い原色を使い、状態を一目で識別できるようにする。

| トークン | 値 | 用途 |
| :--- | :--- | :--- |
| `success` | `#008000` | 保存完了・成功 |
| `warning` | `#FFA500` | 注意・在庫警告 |
| `error` | `#FF0000` | エラー（`destructive` と同値） |
| `info` / `blue` | `#0000FF` | 情報・リンク（`ghost`/`link` ボタンの文字色） |

補助として `input-hover` / `input-disabled` / `border-disabled` を用意し、
入力欄の hover・非活性表現に使う。

---

## Typography

Google Fonts を `index.html` で読み込み、`index.css` の `@theme` で変数化している。

- **Headline**: `Archivo Black`（`--font-headline` / `font-headline`）— 見出し・ボタン
- **Body**: `Work Sans`（`--font-body` / `font-body`）— 本文（`body` 既定）
- **Mono**: `Space Mono`（`--font-mono` / `font-mono`）— ラベル・データ・POS/管理UI

### タイプスケール（`@layer base`）

| 要素 / クラス | フォント | サイズ / 行間 | ウェイト |
| :--- | :--- | :--- | :--- |
| `h1` | headline | clamp(32px, 8vw, 64px) / 1.0 | normal |
| `h2` | headline | clamp(28px, 6vw, 48px) / 1.05 | normal |
| `h3` | headline | clamp(22px, 4.5vw, 32px) / 1.1 | normal |
| `h4` | body | clamp(18px, 4vw, 22px) / 1.2 | semibold |
| `.text-body` | body | 16px / 1.6 | normal |
| `.text-small` | body | 14px / 1.5 | normal |
| `.text-tiny` | body | 12px / 1.4 | normal |
| `.text-mono` | mono | 15px / 1.5 | normal |

管理画面のラベルは `text-xs font-bold uppercase`、注記は `text-[10px]` を多用する。

---

## Spacing

Tailwind の標準スペーシングに加え、`--spacing-sp-1〜8`（4/8/16/24/40/64/80/120px）を
`p-sp-4` のように参照できる。密度の高い管理UIでは `space-y-4` / `gap-4` を基本単位とする。

## Border Radius / Elevation

- **Radius**: 全て `0px`。`rounded-*` は使わない（base で `rounded-none` 強制）。
- **Elevation**: 影は使わない（base で `shadow-none` 強制）。モーダルのみ背景に
  `backdrop-blur-sm` + `bg-foreground/80` のオーバーレイを敷いて前後関係を示す。

### 枠線は「押せるもの」の合図（2026-07-04 方針）

枠線＝インタラクティブの手がかりとして使う。**押せないものは枠で囲まない。**

- **枠線を付ける**: ボタン、入力欄／セレクト／チェックボックス、**クリックできるカード・行**。
- **枠線を付けない**: 表示専用カード・情報ボックス・非クリックの行など「押せない囲み枠」。
- **区切り線は別扱い**: 見出し下線やセクション区切り（`border-b-*` 等の**方向指定**）は
  情報を区切るために残す。「囲み枠（全辺）」とは役割が違う。
- **例外**: モーダル本体の枠（ダイアログ面の輪郭）、空状態の破線ボックス、
  QR/印刷面・画像サムネイルの枠は、機能・意味を持つため残す。

→ `Card` はこの方針を体現する。既定 `variant` は**枠線なし**（表示用）、
クリックできるカードは `variant="interactive"`（枠線＋ホバー）、明示的に囲みたい箱は
`variant="bordered"` を使う。

### 枠線ユーティリティ（`@layer utilities`）

枠線の太さは **必ずこの3段階トークンを使う**。任意px（`border-[2px]` 等）は使わない
（かつては 1〜6px が混在し「太さがバラバラ」の原因になっていた）。

| クラス | 太さ | 用途 |
| :--- | :--- | :--- |
| `border-thin` | 1px | 区切り線・控えめな境界 |
| `border-thick` | 3px | 既定の枠（カード・入力・ボタン・モーダル） |
| `border-heavy` | 5px | フォーカス・アクティブの強調 |

- **色は焼き込まない**: トークンは幅のみを定義し、色は base の `* { @apply border-border }`
  と個別の `border-<color>`（`border-primary` 等）が担う。これにより色指定との競合が起きない。
- **方向指定版あり**: `border-t-thick` / `border-b-thin` / `border-l-heavy` … のように
  各辺 × 各段階を定義済み。以前は方向指定版が未定義で `border-b-thick` が
  **何も描画しない**（区切り線が消える）不具合があった（2026-07-04 修正）。

---

## Components

実コンポーネントは [`apps/register/src/components/ui`](../apps/register/src/components/ui) を参照。
**新しい素の UI を勝手に足さず、まず既存の共通コンポーネントを使う**（`AGENTS.md` の UI ルール）。

### Button（`ui/button.tsx`）

`cva` によるバリアント。全て `border-thick`・`font-headline uppercase tracking-[2px]`、
hover で前景/背景反転、active で `border-heavy`。

- **default**: primary 塗り → hover で背景色に反転
- **destructive**: 赤塗り → hover で primary 背景＋赤文字
- **outline / secondary**: 背景塗り → hover で primary 反転
- **ghost / link**: 枠なし・`info` 色の下線テキスト
- サイズ: `sm(min 32px) / default(min 44px) / lg(min 56px) / icon(44px)`。ラベルは折り返し可能にし、文言が増えても固定高や親幅を押し広げない。

### Input（`ui/input.tsx`）

`bg-input` + `border-thick`、`font-mono text-[15px]`、hover で `bg-input-hover`、
フォーカスで `border-heavy`（リングは出さない `focus-visible:ring-0`）、
`aria-invalid` で `border-error`。フォーム内で使う場合は後述の `FormField` 経由が基本。

### Card（`ui/card.tsx`）

影・角丸なしの矩形。**枠線は「押せるもの」の合図**という方針に従い、`variant` で出し分ける:
- `default`（既定）: 枠線なし。表示専用カード。
- `interactive`: 枠線 + ホバー強調。クリックできるカード。
- `bordered`: 枠線あり（モーダル本体など明示的な囲み）。
- `elevated`: 太枠（`border-heavy`）。

### Modal（`ui/Modal.tsx`）★共通化コンポーネント

管理画面のフォーム系モーダルの外枠。以下を内包する:

- `bg-foreground/80 + backdrop-blur-sm` のオーバーレイ（クリックで `onClose`）
- `border-thick` の Card、ヘッダー（`[タイトル]` + × ボタン）、`CardContent` ラッパー
- **Escape で閉じる**・**背景スクロールロック**・`role="dialog"` / `aria-modal`（a11y）
- `maxWidth`: `md / lg / xl`

```tsx
<Modal isOpen={isOpen} onClose={handleClose} title="[新規メニュー追加]">
  {/* フィールド群 */}
</Modal>
```

### FormField / FormSelect / FormSubmitButton / EditModeBanner（`ui/FormField.tsx`）★共通化

- **FormField**: `Label(text-xs font-bold uppercase)` + `Input` を `htmlFor`/`id` で紐付け。
  共通スタイルは `formControlClassName` にまとめてある。`required` で ` *` を付与。
- **FormSelect**: 同じ体裁の `<select>`。
- **FormSubmitButton**: 新規作成モーダル右下の送信ボタン（処理中はスピナー）。
- **EditModeBanner**: 「フォーカスを外すと自動保存」注記（`success` 色 / `muted` 背景）。

### ConfirmationDialog / ConfirmDialog（`ui/*.tsx`）

- **ConfirmationDialog**: 未保存の入力があるまま閉じようとした際の3択
  （[保存して閉じる] / [保存せず閉じる] / [入力を続ける]）。
- **ConfirmDialog**: 削除・退出・アンインストール等の破壊的操作の2択確認
  （[実行する] / [キャンセル]、`destructive` で赤ボタン）。

> **ネイティブ `alert()` / `confirm()` は使わない**。ブラウザにブロックされ得るうえ
> デザインが崩れるため、確認は必ず上記のアプリ内ダイアログで行う。

---

## フォームモーダルのパターン（`hooks/useEntityForm.ts`）

Circle / Menu / Topping / Staff / EventStaff の各 FormModal は、
**新規=作成 / 編集=`onBlur` 自動保存 / 未保存入力ありなら閉じる前に確認** という
共通のデータ操作を持つ。この振る舞いは `useEntityForm` フックに集約している。

- 新規作成: `validate` → `create` → 成功トースト → クエリ無効化 → クローズ
- 編集: 入力欄の `onBlur` で差分があれば `update` を自動保存（トーストは `toastId` で集約）
- 画像など blur を伴わない項目は `saveNow(next)` で即時保存
- エンティティ固有差分（例: サークル PIN の保存後クリア）は `onAfterAutoSave` 等で注入

新しい「一覧＋追加/編集モーダル」を作る場合は、この3ファイル
（`Modal` / `FormField` / `useEntityForm`）を組み合わせること。

---

## Do's and Don'ts

1. **Do** 太枠と反転で状態を示す。**Don't** グラデーション・影・角丸を足さない。
2. **Do** ラベル/見出しは `font-mono uppercase`、モーダル見出しは `[…]` 形式で統一する。
3. **Do** 状態表現は `success/warning/error/info` トークンを使う。**Don't** 素の
   Tailwind カラー（`text-green-600` 等）を直書きしない。
4. **Do** アクセントは1色に絞る。単色主義を保つ。
5. **Do** 入力欄は `FormField`、モーダルは `Modal`、確認は `ConfirmationDialog` を再利用する。
   **Don't** 同じ JSX/クラス文字列をコピペしない。
6. **Do** カラー・サイズ変更は `index.css` のトークンを起点にし、本書を追従させる。
7. **Do** キーボード操作（Escape 閉じ・フォーカス可視化）とラベル紐付けに配慮する。
