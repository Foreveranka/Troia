# Troia — Sunum Rehberi (6 Geliştirmenin Kanıtı)

> **Çalışma dokümanı** (Türkçe, `GELISTIRME_LISTESI.md`'nin kardeşi). Amaç: 2026-08-08'de tamamlanan
> 6 maddelik production-yolu backlog'unun **çalıştığını** bir sunumda kanıtlamak. Üç kanıt katmanı var —
> testler (tek komut), zincir üstü canlı kanıtlar (tarayıcıda açılır) ve canlı demo (isteğe bağlı, en etkilisi).

## 1. Tek komutla test kanıtı

```bash
just verify-features        # just kurulu değilse: brew install just
```

Altı maddenin her biri için etiketli başlık + o maddenin özel test dosyaları koşar; sonunda
`ALL SIX FEATURES PROVEN ✔` basar. (`just` istemiyorsan justfile'daki `verify-features` tarifindeki
komutlar aynen elle koşulabilir; tam gate her zamanki gibi `just ci`.)

Madde → kanıt dosyası → kanıtladığı şey:

| #        | Test dosyaları                                                                                                                                                | Sunumda söylenecek cümle                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A-1**  | `composition/test/sqlite-order-store.spec` · `sqlite-order-registry.spec` · `order-recovery.spec` · `sqlite-sequence-store.spec`                              | "Süreç ödemenin ortasında ölse bile sipariş, rezervasyon ve sayaçlar diskte; restart kaldığı yerden devam eder — testte gerçek dosya üstünde çökme simüle edilir." |
| **A-2**  | `backend/test/settlement/settlement-worker.spec` (wal-a…d) · `composition/test/mint-intent-journal.spec`                                                      | "Havuz dolumu mint'ten ÖNCE niyetini yazar; önceki hayattan açık niyet ikinci mint'i süresiz engeller — aynı para asla iki kez basılmaz."                          |
| **A-5**  | `core/test/channel-pool.spec` · `stellar-client/test/channel-submit.spec` · `reconciler/test/channel-witness.spec` · `backend/test/engine/channel-alloc.spec` | "Ödemeler kanal hesaplarından paralel çıkar; operator yetkisi imzalı vekâletnameyle taşınır, sahte vekâletname denetçiden dönemez."                                |
| **B-11** | `app/extension/test/wizard-core.spec` · `background.spec` · `stellar-client/test/account-snapshot.spec` (SEP-29)                                              | "Kullanıcı herhangi bir cüzdan adresini yapıştırıp Troy kartıyla öder; borsa deposit adresi daha tahsilat olmadan, sebebi açıklanarak reddedilir."                 |
| **C-13** | `backend/test/http/session.spec` · `composition/test/server-smoke.spec`                                                                                       | "Token'sız /intent 401; oturum başına sipariş bütçesi 429; dürüst çift-tık bedava — havuzu kimse bedavaya rezerve edemez."                                         |
| **D-17** | `composition/test/observability.spec`                                                                                                                         | "Kritik her alarm hem /metrics'te hem webhook kanalında; alarm yolu para yolunu asla düşüremez."                                                                   |

## 2. Zincir üstü canlı kanıtlar (tarayıcıda aç, itiraz edilemez)

2026-08-08 canlı tatbikatının üç işlemi — testnet explorer'da herkes doğrulayabilir:

| Kanıt                                                                       | Link                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Eşzamanlı ödeme 1 → **channel-1** (ledger 4035197)                          | `https://stellar.expert/explorer/testnet/tx/56457a195d89409dbf20b714c444d6ac6cf80334f6bf87361b18eb7beebf78c9` |
| Eşzamanlı ödeme 2 → **channel-2** (ledger 4035200)                          | `https://stellar.expert/explorer/testnet/tx/cad50dff1f793745db023a1904d781c7d33b0be314da27ce32fba8798f374e6f` |
| **Süreç ölüyken ödenen** siparişin teslimi → **channel-3** (ledger 4035346) | `https://stellar.expert/explorer/testnet/tx/ec76e640696503b1c2dc5a5df375aebde8b810e4e0801663ea45fd3d0256cacb` |

Sunumda gösterilecek şey: her üç işlemin **source account'ları farklı** (kanal hesapları — A-5) ve
üçüncüsü, backend tamamen kapalıyken kartla ödenen bir siparişin restart sonrası kendi kendine
teslimi (A-1). Anlatının tamamı `DEPLOYMENTS.md → "Channel accounts live drill"` bölümünde.

## 3. Canlı demo senaryosu (~10 dk, en etkileyici katman)

Ön koşul: `.env` dolu, `pnpm -r build` güncel. Sandbox kart: `9792072000017956` · 12/30 · 123 · 3DS kodu ekranda.

```bash
node --env-file=.env packages/composition/dist/main.js     # 1) boot logunu göster:
#    "[channels] 5 channel account(s) armed"  ← A-5 açık
#    "[order-db] ..."                          ← A-1 kalıcı store devrede
```

**Demo 1 — normal ödeme (2 dk):** `node scripts/intent.mjs demo1 5` → `demo/checkout.html`'i aç, öde →
`curl localhost:3000/status/demo1` pending→processing→completed → `curl localhost:3000/receipt/demo1`
tx hash'i explorer'da aç. (C-13 bu akışın içinde görünmezce çalıştı: script önce `/session` aldı.)

**Demo 2 — crash provası (4 dk, yıldız numara):** `node scripts/intent.mjs demo2 5` → form açılınca
**backend'i Ctrl-C ile öldür** → seyirciye "sistem ölü, müşteri ödüyor" de, formu öde → backend'i tekrar
başlat → boot logunda `recovered in-flight order demo2 (SolvencyReserved)` satırını göster → ~15 sn
içinde `completed` + receipt. "Müşteri ödedi, sistem çöktü, kimse dokunmadı, para yerine ulaştı."

**Demo 3 — gözlemlenebilirlik (1 dk):** `curl localhost:3000/metrics` → havuz, drift=0, settlement
sayacı. (İstersen `TROIA_ALERT_WEBHOOK_URL`'e bir Slack webhook koy; alarm anında kanala düşer.)

**Demo 4 — wizard (2 dk, extension yüklüyse):** `app/extension`'da `npm run build` → `dist/`'i
chrome://extensions'a yükle → popup → **Manual payment** → herhangi bir G-adresi + tutar → aynı akış.
Borsa reddi için `config.memo_required` data entry'li bir hesaba denemek SEP-29 mesajını gösterir.

**Demo 5 — güvenlik kapısı (30 sn):** `curl -s -X POST localhost:3000/intent -H 'content-type: application/json' -d '{}'`
→ `401 SessionRequired` — token'sız kimse kapıdan giremiyor (C-13).

## 4. Anlatı iskeleti (slayt sırası önerisi)

1. **Problem:** kart altyapısı olmayan crypto-kabul eden platformlarda Troy kartıyla ödeme.
2. **Mimari bir cümlede:** müşteri TL öder (iyzico) → operatör havuzdan USDC teslim eder (Stellar) → kur farkı gelir.
3. **Para-güvenliği ilkesi:** önce rezerve, sonra tahsil, en son geri-alınamaz adım; her belirsizlik fail-closed.
4. **6 geliştirme** (yukarıdaki tablo — her birine bir cümle).
5. **Kanıt:** `just verify-features` yeşil duvarı + üç explorer linki + (yapabiliyorsan) canlı crash demosu.
6. **Sırada ne var:** ertelenenler listesi (`GELISTIRME_LISTESI.md`) — bilinçli kapsam, unutulmuş iş değil.
