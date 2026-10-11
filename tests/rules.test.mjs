// ============================================================
// セキュリティルールの自動テスト(エミュレータに対して実行)
//   先に scripts/dev.sh でエミュレータを起動しておく
//   実行: cd tests && npm test
//   注意: エミュレータ上のデータを消すので，実行後に seed-emulator.sh を再実行する
// ============================================================
import { test, before, beforeEach, after } from "node:test";
import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from "@firebase/rules-unit-testing";
import {
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, collection,
  serverTimestamp, arrayUnion, arrayRemove,
} from "firebase/firestore";

const ORG = "org@example.com";
let env;

// ---- 登場人物 ----
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: "anonymous" } }).firestore();
const google = (uid, email) => env.authenticatedContext(uid, {
  email, email_verified: true, firebase: { sign_in_provider: "google.com" },
}).firestore();
const organizer = () => google("org", ORG);

const newPost = (uid, extra = {}) => ({
  text: "質問です", name: "たぬき", uid, createdAt: serverTimestamp(),
  parentId: null, hidden: false, likedBy: [], ...extra,
});

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-juku-mondo",
    firestore: { host: "127.0.0.1", port: 8080, rules: readFileSync("../firestore.rules", "utf8") },
  });
});
after(async () => { await env.cleanup(); });

// 毎回: 許可リスト・受付中のイベント E1・締め切りのイベント E2・投稿 p1 を用意
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "config/organizers"), { emails: [ORG] });
    await setDoc(doc(db, "events/E1"), { title: "合宿", createdBy: "host", createdByEmail: "host@example.com", createdAt: new Date(), closed: false });
    await setDoc(doc(db, "events/E2"), { title: "終わった回", createdBy: "host", createdByEmail: "host@example.com", createdAt: new Date(), closed: true });
    await setDoc(doc(db, "events/E1/posts/p1"), { text: "最初", name: "", uid: "alice", createdAt: new Date(), parentId: null, hidden: false, likedBy: [] });
    await setDoc(doc(db, "events/E2/posts/q1"), { text: "古い", name: "", uid: "alice", createdAt: new Date(), parentId: null, hidden: false, likedBy: [] });
  });
});

// ---- 許可リスト ----
test("許可リストは載っている幹事だけが読める", async () => {
  await assertSucceeds(getDoc(doc(organizer(), "config/organizers")));
  await assertFails(getDoc(doc(anon("alice"), "config/organizers")));
  await assertFails(getDoc(doc(google("x", "other@example.com"), "config/organizers")));
  await assertFails(setDoc(doc(organizer(), "config/organizers"), { emails: [ORG, "evil@example.com"] }));
});

// ---- イベント ----
test("イベントを作れるのは幹事だけ", async () => {
  const ev = (uid, email) => ({ title: "新回", createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(), closed: false });
  await assertSucceeds(addDoc(collection(organizer(), "events"), ev("org", ORG)));
  await assertFails(addDoc(collection(anon("alice"), "events"), ev("alice", null)));
  await assertFails(addDoc(collection(google("x", "other@example.com"), "events"), ev("x", "other@example.com")));
  // 作成者を他人に偽れない
  await assertFails(addDoc(collection(organizer(), "events"), ev("someone", ORG)));
});

test("イベントはIDを知っていれば読めるが，一覧は幹事だけ", async () => {
  await assertSucceeds(getDoc(doc(anon("alice"), "events/E1")));
  await assertFails(getDocs(collection(anon("alice"), "events")));
  await assertSucceeds(getDocs(collection(organizer(), "events")));
});

test("締め切り・削除は司会(作成者か幹事)だけ", async () => {
  await assertFails(updateDoc(doc(anon("alice"), "events/E1"), { closed: true }));
  await assertSucceeds(updateDoc(doc(anon("host"), "events/E1"), { closed: true }));
  await assertSucceeds(updateDoc(doc(organizer(), "events/E1"), { closed: false }));
  await assertFails(updateDoc(doc(organizer(), "events/E1"), { createdBy: "org" }));
  await assertFails(deleteDoc(doc(anon("alice"), "events/E1")));
  await assertSucceeds(deleteDoc(doc(organizer(), "events/E1")));
});

// ---- 投稿 ----
test("参加者は自分名義でだけ投稿できる", async () => {
  const db = anon("bob");
  await assertSucceeds(addDoc(collection(db, "events/E1/posts"), newPost("bob")));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("alice")));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { likedBy: ["bob"] })));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { hidden: true })));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { text: "" })));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { text: "あ".repeat(2001) })));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { extra: 1 })));
  // ログインしていない人は読めない
  await assertFails(getDocs(collection(env.unauthenticatedContext().firestore(), "events/E1/posts")));
});

test("返信は実在する投稿にだけぶら下げられる", async () => {
  const db = anon("bob");
  await assertSucceeds(addDoc(collection(db, "events/E1/posts"), newPost("bob", { parentId: "p1" })));
  await assertFails(addDoc(collection(db, "events/E1/posts"), newPost("bob", { parentId: "nope" })));
});

test("締め切ったイベントには投稿もいいねもできない", async () => {
  const db = anon("bob");
  await assertFails(addDoc(collection(db, "events/E2/posts"), newPost("bob")));
  await assertFails(updateDoc(doc(db, "events/E2/posts/q1"), { likedBy: arrayUnion("bob") }));
  await assertSucceeds(getDocs(collection(db, "events/E2/posts")));
});

// ---- いいね ----
test("いいねは自分の1票だけ付け外しできる", async () => {
  const ref = (u) => doc(anon(u), "events/E1/posts/p1");
  await assertSucceeds(updateDoc(ref("bob"), { likedBy: arrayUnion("bob") }));
  await assertSucceeds(updateDoc(ref("carol"), { likedBy: arrayUnion("carol") }));
  // 他人の票を足す・消す
  await assertFails(updateDoc(ref("bob"), { likedBy: arrayUnion("dave") }));
  await assertFails(updateDoc(ref("bob"), { likedBy: arrayRemove("carol") }));
  // 2票入れる(重複)・まとめて入れる
  await assertFails(updateDoc(ref("bob"), { likedBy: ["bob", "carol", "bob"] }));
  await assertFails(updateDoc(ref("eve"), { likedBy: ["bob", "carol", "eve", "frank"] }));
  // いいねのついでに本文を書き換える
  await assertFails(updateDoc(ref("eve"), { likedBy: arrayUnion("eve"), text: "改ざん" }));
  // 外す
  await assertSucceeds(updateDoc(ref("bob"), { likedBy: arrayRemove("bob") }));
});

// ---- 非表示と削除 ----
test("非表示にできるのは司会だけ", async () => {
  await assertFails(updateDoc(doc(anon("alice"), "events/E1/posts/p1"), { hidden: true }));
  await assertSucceeds(updateDoc(doc(anon("host"), "events/E1/posts/p1"), { hidden: true }));
  await assertSucceeds(updateDoc(doc(organizer(), "events/E1/posts/p1"), { hidden: false }));
  await assertFails(updateDoc(doc(anon("host"), "events/E1/posts/p1"), { text: "改ざん" }));
});

test("投稿を消せるのは本人か司会", async () => {
  await assertFails(deleteDoc(doc(anon("bob"), "events/E1/posts/p1")));
  await assertSucceeds(deleteDoc(doc(anon("alice"), "events/E1/posts/p1")));
});
