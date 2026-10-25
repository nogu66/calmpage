// ファイル一覧に出すものの種類。main（一覧・見張り）と画面（開き方）の両方で使う。

// 組み直しのきっかけになるソース
const SOURCE = /\.(tex|bib|cls|sty|bst)$|^\.?latexmkrc$/i
// ソースではないが、エディターで開いて書き換えられるテキスト
const TEXT = /\.(txt|csv|tsv|dat|md|bbx|cbx|lbx|dbx|dtx|ins|def|cfg|clo|fd|ldf|ist|lua|json|ya?ml)$/i
// 中身を見るだけのもの（Quick Look で開く）
const IMAGE = /\.(png|jpe?g|pdf|eps|svg)$/i

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function isSource(path: string): boolean {
  return SOURCE.test(base(path))
}

export function isText(path: string): boolean {
  return isSource(path) || TEXT.test(base(path))
}

export function isImage(path: string): boolean {
  return IMAGE.test(base(path))
}

export function isListed(path: string): boolean {
  return isText(path) || isImage(path)
}
