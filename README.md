# Backgammon Position Quiz

`yanagibackgammon/positions` が公開する解析済みポジションデータを利用する、GitHub Pages向けの静的クイズです。

## データ連携

クイズ本体は以下を毎回直接読み込みます。

- `https://yanagibackgammon.github.io/positions/data/positions.json`
- `positions.json` の `quizBoardImage` が指すPIP非表示の盤面SVG

そのため `positions` 側へ棋譜を追加して正常にデプロイされれば、`quiz` 側を再ビルドしなくても新しいポジションが出題対象へ加わります。

## 出題種別

- Checker Play
- Double Action
- Take Action

`positions.json` の `decisionKind` (`checker` / `double` / `take`) を使って分類します。

## 学習履歴

ブラウザの `localStorage` にポジションID単位で次を保存します。

- 正解回数
- 不正解回数

「課題」は次のいずれかに該当するポジションです。

- 正解回数が0回
- 正解回数 < 不正解回数

履歴は端末・ブラウザごとに保存されます。

## GitHub Pages

`main` ブランチへのpushで `.github/workflows/deploy.yml` が実行されます。GitHub側の Pages Source は **GitHub Actions** を選択してください。
