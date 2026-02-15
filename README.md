# WordBasket

オンライン早押し版のワードバスケット（PHP + フロントエンド）です。

## 動作要件

- PHP 8.1+
- `mbstring` 拡張

## 配置

このリポジトリは `/wordbasket/` 配下にそのまま配置して使う想定です。

- エントリポイント: `/wordbasket/index.php`
- API: `/wordbasket/api.php`
- フロント実体: `/wordbasket/public/index.html`

`index.php` は `public/index.html` を読み込むため、
`https://jujubkitakd.sakura.ne.jp/wordbasket/` へ直接アクセスして利用できます。

## ローカル確認

```bash
php -S 0.0.0.0:8000
```

起動後に `http://localhost:8000/` を開いて、
ルーム作成・参加・プレイ・Undo を確認してください。


## ルール（この実装）

- 配られる手札は1人5枚です。
- カードは「ん」を除くひらがなです。
- 手札からカードを場に出すと手札は減り、補充されません。
- 手札を先に0枚にしたプレイヤーが勝利です。
- 単語入力は不要で、手札カードを選択して「決定（場に出す）」でプレイします。
