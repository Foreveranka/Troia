# Troia — Geliştirme Listesi (Production Yolu)

> **Çalışma dokümanı** — 2026-07-29 tarihli analiz oturumunun çıktısı; son güncelleme 2026-08-08
> (liste 6 maddeye indirildi, ertelenenler aşağıda). Repo'nun kanonik (İngilizce) dokümanlarından
> bağımsız, ürün sahibinin planlama notudur. Regülasyon kapsam dışıdır; yalnızca geliştirme
> odaklıdır. Karar geçmişi en altta.

## Onaylı geliştirmeler

| #        | Geliştirme                           | Problem                                                                                                                                                                                                                                                               | Çözüm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-1**  | Kalıcı order store (DB)              | Sipariş kayıtları RAM'de; müşteri iyzico formunda ödedikten sonra process çökerse sipariş unutuluyor — müşteri ödemiş, satıcı ödenmemiş, iade yok. Ayrıca iki backend instance'ı aynı son parayı iki kez rezerve edebiliyor, retry sayaçları restart'ta sıfırlanıyor. | Sipariş, rezervasyon ve sayaçlar gerçek bir veritabanına tek transaction'da yazılır. Restart sonrası recovery yarım kalan siparişi bulur: iyzico'dan durumu sorar, ya USDC'yi gönderip tamamlar ya satışı iptal edip iade eder. DB satır kilidi çoklu-instance sorununu da kapatır.                                                                                                                                                                                                                                                                                                                                        |
| **A-2**  | Mint write-ahead journal             | Havuz dolumu "önce mint, sonra defter kaydı" sırasıyla çalışıyor; aradaki crash'te dolum kayıtsız kalıyor ve restart'ta aynı dolum ikinci kez yapılıyor. Mainnet'te bu, aynı gerçek paranın iki kez harcanması demek.                                                 | `pay()` yolundaki disiplinin aynısı: mint'ten **önce** diske "dolum yapıyorum" niyeti yazılır, mint sonrası "tamamlandı" ile kapatılır. Restart'ta açık niyet görülür, ikinci mint engellenir.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **A-5**  | Channel accounts                     | Tüm ödemeler tek operator hesabının sıra numarasıyla imzalanıyor → tüm sistemde aynı anda tek ödeme, tavan dakikada ~2-4 işlem. Müşteri sayısı arttıkça kuyruk büyür.                                                                                                 | Önceden açılmış yardımcı hesap havuzu; her ödeme boştaki bir kanalın sıra numarasını kullanır, yetki operator'da kalır. 10 kanal = 10 paralel ödeme. Allocator arayüzü değişmez.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **B-11** | Manuel ödeme wizard'ı                | Extension bugün sadece kendi mağazamızdaki SEP-7'yi tanıyor; dünyadaki crypto checkout'ların çoğu SEP-7 basmıyor → ürün vaadi ("her platformda öde") karşılanmıyor.                                                                                                   | Extension'ın kendi sekmesinde wizard: adres gir → doğrula (strkey + hesap/trustline kontrolü + SEP-29 "memo zorunlu" adresleri açık mesajla reddet) → ≈₺ göster → onay ekranı → iyzico formu → zincir makbuzu. Memo alanı yok (Soroban işlemleri tx memo taşıyamaz — protokol kısıtı). İşlem başına üst tutar limiti gömülü. Manifest genişletmesi gerektirmez.                                                                                                                                                                                                                                                            |
| **C-13** | `/intent` auth + rezervasyon bütçesi | `/intent` kimliksiz; bir script sahte intent'lerle havuzun tüm USDC'sini rezerve edip gerçek müşterilere "yetersiz bakiye" gösterebilir (para çalınmaz ama dükkân kapanır). Per-IP limit IP değiştirenle aşılır.                                                      | Storefront/extension'a backend'in verdiği kısa ömürlü oturum token'ı olmadan intent kabul edilmez; rezervasyon bütçesi IP yerine oturum başına sayılır.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **D-17** | Gözlemlenebilirlik                   | Drift alarmı, `ROGUE PAYOUT`, `LossReview` gibi kritik sinyaller sadece log'a yazılıyor; kimsenin haberi olmadan çalabilirler.                                                                                                                                        | Metrik toplama + alerting (havuz seviyesi, drift, review sayısı, poll gecikmesi); kritik eşikte bildirim çalar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **M-1**  | Muxed (`M…`) hedef desteği           | Soroban ödemeleri tx memo taşıyamadığı için (MEMO_NONE) gelen parayı memo'yla eşleştiren tüm alıcılar — borsalar, havuz-adresli mağazalar — kapsam dışı; Stellar'da baskın desen bu olduğundan wizard'ın alıcı evreni dar kalıyor.                                    | Protocol 23 (CAP-67) ile SAC transfer artık muxed hedef kabul ediyor ve event'e `toMuxedInfo` yazıyor — eşleştirme kimliği adresin içinde taşınır. Uçtan uca destek: strkey doğrulayıcılar `M…` öğrenir (extension + core), kimlik türetimi "aynı G + farklı id = farklı hedef" kuralını sindirir, kontrat `pay()` hedefi muxed ScAddress alır (SDK yükseltme + `upgrade()` seremonisi + canlı prova), reconciler `toMuxedInfo`'yu doğrular. Sınırlar: klasik-memo alıcıları ve metin-referanslı sistemler yine kapsam dışı; alıcının CAP-67-farkındalı indexer'ı olmalı. Orta-büyük iş; A-5 gibi tasarım-belgeli gitmeli. |

## Durum

- **M-1 — YENİ (2026-08-08): açık tek madde.** Muxed hedef desteği; gerekçe ve kapsam yukarıdaki
  tabloda. Öncelik kararı verilmedi — sunum sonrası ele alınacak. Ön koşul notu: kontrat
  değişikliği içerdiği için `upgrade()` seremonisi ve canlı tatbikat şart (D-18 disipliniyle).

- **A-1 — YAPILDI (2026-08-08).** SQLite tabanlı kalıcı order store + registry
  (`packages/composition/src/order-db.ts`, `sqlite-order-store.ts`, `sqlite-order-registry.ts`).
  Kapanan açıklar: SolvencyReserved'da çöken sipariş restart'ta poll worker'ın iş listesine geri
  geliyor (KNOWN_ISSUES §1'in müşteri-ödedi-satıcı-ödenmedi penceresi); rezervasyonlar fail-closed
  replay ediliyor; retry sayaçları, webhook dedup ve loss bayrakları restart'ı aşıyor. 26 yeni test
  (sözleşme + reopen/crash simülasyonu + factory üzerinden uçtan uca recovery). Not: çoklu-instance
  satır kilidi hâlâ YOK (tek process varsayımı sürüyor — KNOWN_ISSUES §3); canlı testnet'te
  crash/restart tatbikatı henüz yapılmadı. Runtime `node:sqlite` kullanıyor (Node ≥ 22.5;
  "experimental" uyarısı zararsız).
- **A-5 — CANLIDA KANITLANDI (2026-08-08).** Tatbikat koşuldu: 5 kanal fonlandı, iki eşzamanlı
  sipariş sandbox kartla ödendi ve **iki farklı kanal hesabından** zincire indi (ledger
  4035197/4035200; kanıtlar DEPLOYMENTS.md'de). Refill'ler defterlendi, geçici drift 0'a kapandı,
  restart sonrası kalıcı store iki siparişi de geri getirdi. Tatbikat gerçek bir eksik de yakaladı
  ve aynı gün düzeltildi: canlı denetçi zarf imzasını operator'e karşı doğruluyordu → kanal
  tanıkları yanlışlıkla EVIDENCE_TAMPERED işaretlendi; P2 artık kanal-source'lu tx'te operator'ün
  auth-entry imzasını preimage üzerinden doğruluyor (sahte-tanık ret testiyle). Düzeltme sonrası
  iki sipariş de "the chain agrees — reconciled". **Crash varyantı da aynı gün geçti:** backend
  tamamen ölüyken ödenen sipariş restart'ta kalıcı store'dan bulundu, tahsilat iyzico'dan doğrulandı
  ve channel-3 üzerinden teslim edildi (tx `ec76e640…`, ledger 4035346) — KNOWN_ISSUES §1'in
  "müşteri ödedi, sistem çöktü" penceresi canlı provayla kapandı; denetçi de onayladı, sıfır alarm.
- **A-5 arşiv notu (aynı gün, önceki durumlar): kod tamam → tasarım+çekirdek.** İmza yarısı da bitti:
  kanal-source'lu `pay()`'de operator yetkisi imzalı address-credential auth entry olarak taşınıyor
  (`signAuthEntry` + `assembleWithSignedAuth`, imzasız/yabancı/yanlış-şekilli entry'ler assemble
  edilmeden reddedilir); write-ahead disiplini korunuyor (persist → send, imzalı entry'ler tx
  gövdesinde); deadness okuması kanal hesabını hedefliyor; kanal kimliği ctx/codec-v2/store/poll
  boyunca taşınıyor; `TROIA_CHANNEL_SECRETS` + `just add-channels N` hazır. Yan kazanç: operator
  allocator snapshot'ı da artık kalıcı — A-1'in son recovery deliği (restart sonrası
  reuseOnDead/confirmBurned UnknownSeq) kapandı. Kanal modu yalnızca env set edilince açılır;
  edilmezse tek-operator yolu bayt-bayt aynı (testle sabit). **Canlıya güvenmeden önce
  `docs/CHANNEL_ACCOUNTS_DESIGN.md` sonundaki tatbikat koşulmalı** (5 adım; birlikte koşacağız).
- **A-5 arşiv notu (aynı gün, önceki durum): tasarım + çekirdek.** Keşif, işin backlog
  tahmininden büyük olduğunu gösterdi: kanal source'lu Soroban tx'inde operator yetkisi **imzalı
  address-credential auth entry**'ye dönüşüyor (bugünkü assemble.ts bunu bilerek fail-closed
  reddediyor), pre-submit hash disiplini yeniden türetilmeli ve deadness kanıtı kanal-başına
  okunmalı. Yapılan: `ChannelPoolProvider` (@troia/core, 9 test) — sipariş başına yapışkan kanal
  ataması (double-pay kalkanı hesap-başına çalıştığı için para-kritik), aynı-ledger kanallarının
  çakışan seq numaralarında fail-closed belirsizlik reddi, restart'ta atama geri yükleme;
  `SequenceProvider.confirmBurned` orderId parametresi kazandı. Kalan işin tam sırası ve gerekçesi
  `docs/CHANNEL_ACCOUNTS_DESIGN.md`'de — imza/deadness yarısı bilinçli olarak ayrı, küçük bir diff
  olarak yapılacak (para yolunun en kritik parçası; canlı testnet provası şart).
- **D-17 — YAPILDI (2026-08-08).** Sıfır yeni bağımlılıkla gözlemlenebilirlik:
  `GET /metrics` Prometheus text formatında pano metrikleri (havuz available/expected/observed/drift,
  poll süresi ve sayaçları, settlement/mint-blocked, rogue payout, tail-stalled, LossReview açık
  sayısı, reconcile durumu — stroop'lar tam bigint, float'a asla düşmez); opsiyonel
  `TROIA_ALERT_WEBHOOK_URL` env'i (Slack/Discord uyumlu) konsoldaki TÜM kritik alarmların ikinci
  kanalı (SOLVENCY ALARM, ROGUE PAYOUT, TAIL STALLED/BLIND SPOT, MINT BLOCKED, POOL CODE REPLACED,
  RECONCILIATION FAILED, yeni LOSS REVIEW artış alarmı). Bildirici fire-and-forget + anahtar başına
  5 dk cooldown — alarm yolu para yolunu asla düşüremez; webhook ölürse konsola geri düşer.
- **B-11 — YAPILDI (2026-08-08).** Manuel ödeme wizard'ı extension'ın kendi sekmesinde
  (`src/wizard/`; popup'taki "Manual payment →" ile açılır): adres + tutar → offline doğrulama
  (strkey, işlem başına 500 USDC üst limit — C-14 kalıntısı) → ≈₺ önizleme → onay → aynı iyzico
  akışı → durum + zincir makbuzu. SEP-7 yolundaki money path'in aynısı — backend ikisini ayırt
  edemez. **SEP-29 reddi uçtan uca gerçek:** Horizon snapshot'ı `config.memo_required` data
  girdisini taşıyor, `PayoutIntent.build` yeni `DestinationMemoRequired` hatasıyla fail-closed
  reddediyor, wizard bunu "borsa deposit adresi ödenemez" diliyle açıklıyor. Manifest genişlemedi
  (kendi sekmesi); background artık kendi extension sayfalarını da (id + origin çifte kontrolüyle)
  kabul ediyor. Testler: wizard-core sözleşmesi, SEP-29 snapshot→build zinciri, background sender
  kuralları.
- **C-13 — YAPILDI (2026-08-08).** `/intent` artık kısa ömürlü HMAC oturum token'ı istiyor
  (token'sız → 401; `POST /session` mint ediyor, IP başına limitli) ve her YENİ sipariş oturum
  bütçesinden düşülüyor (bütçe bitince → 429). Bütçe IP'ye değil sunucunun verdiği kimliğe bağlı;
  idempotent tekrar (aynı siparişe ikinci tık) bütçe yakmıyor. Extension token'ı kendisi alıp
  cache'liyor, 401'de bir kez tazeleyip yeniden deniyor (backend restart'ı kendiliğinden iyileşir;
  secret kasıtlı olarak boot başına rastgele — konfigürasyon yok). Per-IP limitler dış katman olarak
  duruyor. Dürüst kalan risk: çok-IP'li dağıtık saldırgan hâlâ oturum toplayabilir — bütçe her
  birini sınırlar, maliyeti yükseltir ama dağıtık vakayı tamamen kapatmaz.
- **A-2 — YAPILDI (2026-08-08).** Mint write-ahead journal: settlement worker mint'ten **önce**
  `orders.db`'ye açık niyet yazıyor, defter kaydından **sonra** kapatıyor. Önceki hayattan açık
  kalmış niyet o ref'in mint'ini süresiz blokluyor (asla ikinci mint yok) ve hem boot'ta
  (`[mint-wal] UNRESOLVED MINT INTENT`) hem tick'te (`MINT BLOCKED`, tek seferlik) alarm basıyor;
  çözüm insana ait: mint zincire inmişse defterine işle (hasRef bayat niyeti kendiliğinden kapatır),
  inmemişse niyeti temizle. Aynı hayat içindeki temiz retry bloklanmaz. KNOWN_ISSUES §2 kod
  seviyesinde kapandı; A-3 (gerçek CEX) artık bu korumanın arkasına gelebilir. Canlı tatbikat
  yapılmadı.
- **A-1 ek (2026-08-08): çoklu-instance solvency kilidi kapatıldı.** `reserve()`'ün KONTROL→TAAHHÜT
  adımı artık tek `BEGIN IMMEDIATE` SQLite transaction'ı — aynı `orders.db`'yi paylaşan iki process
  aynı son parayı iki kez rezerve edemez (iki-bağlantı testleriyle sabitlendi). Not: iki instance
  çalıştırmak yine de desteklenmiyor (sipariş kilitleri ve operator sequence hâlâ process-içi);
  kapanan şey para aritmetiği, deployment modu değil.

## Önerilen sıralama

İki paralel iş kolu:

- **Backend kolu:** A-1 → A-2 → C-13 → D-17 → A-5
- **Extension kolu:** B-11 (bağımsız, hemen başlanabilir)

Bağımlılıklar: A-1 temeldir (A-2 ve C-13 ona yaslanır). D-17 hemen başlanabilir.
A-5'in boyutlandırma verisi normalde D-16 load testinden gelecekti (ertelendi) —
kanal sayısı şimdilik tahminle seçilir, gerekirse D-16 geri alınır.

## Ertelenenler (2026-08-08 — "henüz gerek yok", tamamen elenmedi)

Bu maddeler geçerliliğini koruyor ama şimdilik yapılmayacak; zamanı gelince geri alınır:

| #        | Geliştirme                                | Neden ertelendi / ne zaman geri gelir                                                                                                                             |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-3**  | Gerçek CEX rebalance                      | Mainnet'e gerçekten geçilmeden gerekmiyor; testnet'te self-issued mint yeterli. Mainnet günü **zorunlu** olur ve A-2 ondan önce bitmiş olmalı.                    |
| **B-9**  | Web Store yayın hattı + config ayrıştırma | Extension henüz genele dağıtılmıyor; developer-mode yükleme yetiyor. Store'a çıkma kararıyla geri gelir.                                                          |
| **C-12** | Chargeback yönetimi                       | Sandbox'ta chargeback zaten simüle edilemiyor; gerçek kart trafiği başlayana kadar bekleyebilir. Runbook'u aşağıda notlarda hazır duruyor.                        |
| **D-15** | Ops/admin paneli                          | `LossReview`/kontrat yönetimi şimdilik log + CLI ile idare edilir. Kararlaşan tasarım (kontrat ops dahil, tek anahtar, `set_admin` hariç) karar geçmişinde saklı. |
| **D-16** | Load/soak testi                           | Ölçülecek eşzamanlı trafik henüz yok. A-5'i büyütme/kanal sayısı kararı gerektiğinde geri gelir.                                                                  |
| **D-18** | Canlı tatbikat                            | Test olgunluğu işi, para güvenliği açığı değil; mainnet hazırlığında geri gelir.                                                                                  |
| **D-19** | Log rotation                              | 2 GiB tavanı yıllar uzakta; DB'ye geçiş konuyu zaten küçültecek.                                                                                                  |

## Karar geçmişi (elenenler ve gerekçeleri)

- **A-4 (KMS/HSM + multisig):** Çıkarıldı — MVP'de operator anahtarı env'de kalıyor, tek imza yeterli.
  `Signer` seam'i açık; gerçek para gününde yeniden değerlendirilecek.
- **B-6/B-7 (SEP-7 imza doğrulaması + storefront imzalama):** Çıkarıldı — üçüncü parti mağazalarda
  otomatik banner hedefi bırakıldı; kullanıcı o mağazalarda manuel wizard (B-11) kullanacak.
  Otomatik tespit yalnızca kendi mağazamızda (mevcut allowlist) kalıyor.
- **B-8 (manifest genişletme):** Gereksizleşti — wizard extension'ın kendi sekmesinde yaşadığı için
  `<all_urls>` veya `optional_host_permissions` gerekmiyor.
- **B-10 (satıcı mini-entegrasyonu):** Çıkarıldı — satıcıya hiçbir aksiyon yaptırılmayacak.
- **C-14 (velocity/fraud limit sistemi):** Çıkarıldı — tek kalıntısı, B-11 wizard'ına gömülü
  "manuel işlem başına üst tutar" sabiti. Kalan fraud freni: 3DS zorunluluğu.

## Kritik teknik notlar (oturumdan)

- **Soroban tx'leri memo taşıyamaz** (protokol kısıtı: InvokeHostFunction → MEMO_NONE zorunlu) ve
  `TroyPool.pay()`'in "memo"su tx memo değil kontrat argümanıdır (ADR-11). Bu yüzden borsa deposit
  adresleri (memo bekleyen) desteklenemez; wizard SEP-29 "memo required" bayrağını kontrol edip
  bu adresleri açık mesajla reddeder. **Güncelleme (2026-08-08):** Protocol 23 (CAP-67), SAC
  transferine muxed (`M…`) hedef desteği getirdi — memo'nun adres-içine gömülü modern halefi artık
  Soroban rayından taşınabilir; bkz. M-1. Klasik memo için kısıt aynen geçerli.
- **iyzico'da chargeback API'si yoktur:** itiraz Merchant Panel'e düşer, 7 gün içinde panelden
  belgeyle savunulur, tutar hakedişten kesilir. Kaybedilirse zarar operatöründür (tasarım gereği
  asla müşterinin/satıcının değil); 3DS kaydı ana savunma kozudur.
- **Chargeback runbook'u:** panel/IFN bildirimi → `orderId` eşle → kanıt paketi yükle (3DS + sipariş
  - zincir tx hash) → kazanılırsa kesinti iade, kaybedilirse `CHARGEBACK_LOSS` defter kaydı.
