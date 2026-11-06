import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { google } from "googleapis";
import crypto from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const kms = new KMSClient({});
const scopes = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];
const cookieName = "crm_session";

const oauth = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.CALLBACK_URL
);

const response = (statusCode, body, headers={}) => ({
  statusCode, headers: {"Content-Type":"application/json", ...headers},
  body: JSON.stringify(body)
});
const redirect = (url, headers={}) => ({statusCode:302, headers:{Location:url,...headers}, body:""});
const getCookie = (event, name) => {
  const raw = event.headers?.cookie || event.headers?.Cookie || "";
  return raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.split("=").slice(1).join("=");
};


const notificationTable = () => process.env.NOTIFICATION_TABLE;

async function gmailForTokenRecord(record) {
  if (!record?.encryptedRefreshToken) throw new Error("Refresh token unavailable");
  const decrypted = await kms.send(new DecryptCommand({
    KeyId: process.env.KMS_KEY_ID,
    CiphertextBlob: Buffer.from(record.encryptedRefreshToken, "base64"),
    EncryptionContext: { userId: record.userId, purpose: "gmail-refresh-token" }
  }));
  const client = oauth();
  client.setCredentials({ refresh_token: Buffer.from(decrypted.Plaintext).toString() });
  return google.gmail({ version: "v1", auth: client });
}

async function registerGmailWatch(record) {
  if (!process.env.GMAIL_PUBSUB_TOPIC) throw new Error("GMAIL_PUBSUB_TOPIC is not configured");
  const gmail = await gmailForTokenRecord(record);
  const result = await gmail.users.watch({ userId: "me", requestBody: {
    topicName: process.env.GMAIL_PUBSUB_TOPIC,
    labelIds: ["INBOX"],
    labelFilterBehavior: "INCLUDE"
  }});
  const historyId = String(result.data.historyId || record.historyId || "");
  await ddb.send(new UpdateCommand({
    TableName: process.env.TOKEN_TABLE, Key: { userId: record.userId },
    UpdateExpression: "SET historyId = :h, watchExpiration = :e, watchUpdatedAt = :u",
    ExpressionAttributeValues: { ":h": historyId, ":e": String(result.data.expiration || ""), ":u": new Date().toISOString() }
  }));
  return { historyId, expiration: result.data.expiration };
}

async function scanAllTokenRecords() {
  const records = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: process.env.TOKEN_TABLE, ExclusiveStartKey }));
    records.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return records;
}

async function renewAllWatches() {
  const records = await scanAllTokenRecords();
  for (const record of records) {
    if (!record.encryptedRefreshToken) continue;
    try { await registerGmailWatch(record); }
    catch (err) { console.error("Gmail watch renewal failed for one user", err?.message || "unknown error"); }
  }
  return records.length;
}

async function pubsubPush(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !process.env.PUBSUB_PUSH_AUDIENCE || !process.env.PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL)
    return response(401, { error: "Missing Pub/Sub authentication" });
  let ticket;
  try {
    ticket = await oauth().verifyIdToken({ idToken: match[1], audience: process.env.PUBSUB_PUSH_AUDIENCE });
  } catch { return response(401, { error: "Invalid Pub/Sub authentication token" }); }
  const claims = ticket.getPayload();
  if (claims?.email !== process.env.PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL || claims?.email_verified !== true)
    return response(403, { error: "Pub/Sub service account is not authorized" });

  let envelope;
  try { envelope = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid Pub/Sub JSON" }); }
  const encoded = envelope?.message?.data;
  if (!encoded) return response(204, {});
  let notice;
  try { notice = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
  catch { return response(400, { error: "Invalid Gmail notification data" }); }
  const emailAddress = String(notice.emailAddress || "").toLowerCase();
  const newHistoryId = String(notice.historyId || "");
  if (!emailAddress || !newHistoryId) return response(204, {});

  const records = await scanAllTokenRecords();
  const record = records.find(x => String(x.email || "").toLowerCase() === emailAddress);
  if (!record?.encryptedRefreshToken || !record.historyId) return response(204, {});
  const gmail = await gmailForTokenRecord(record);
  let history;
  try {
    history = await gmail.users.history.list({ userId: "me", startHistoryId: record.historyId, historyTypes: ["messageAdded"] });
  } catch (err) {
    // Gmail may expire old history IDs; reset the watch baseline and acknowledge the push.
    if (err?.code === 404 || err?.response?.status === 404) {
      await registerGmailWatch(record);
      return response(204, {});
    }
    throw err;
  }
  const messageIds = new Set();
  for (const item of history.data.history || []) {
    for (const added of item.messagesAdded || []) if (added.message?.id) messageIds.add(added.message.id);
  }
  for (const messageId of messageIds) {
    const detail = await gmail.users.messages.get({ userId: "me", id: messageId, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    const headers = detail.data.payload?.headers || [];
    const find = name => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
    const createdAt = new Date().toISOString();
    await ddb.send(new PutCommand({ TableName: notificationTable(), Item: {
      userId: record.userId,
      notificationId: `${Date.now()}-${messageId}`,
      messageId,
      from: find("From"), subject: find("Subject"), date: find("Date"),
      snippet: detail.data.snippet || "",
      createdAt,
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
    }}));
  }
  await ddb.send(new UpdateCommand({ TableName: process.env.TOKEN_TABLE, Key: { userId: record.userId },
    UpdateExpression: "SET historyId = :h", ExpressionAttributeValues: { ":h": newHistoryId }}));
  return response(204, {});
}

async function getNotifications(event) {
  const sessionId = getCookie(event, cookieName);
  if (!sessionId) return response(401, { error: "Sign in required" });
  const session = await ddb.send(new GetCommand({ TableName: process.env.SESSION_TABLE, Key: { sessionId } }));
  if (!session.Item || session.Item.expiresAt < Math.floor(Date.now() / 1000)) return response(401, { error: "Session expired" });
  const result = await ddb.send(new QueryCommand({ TableName: notificationTable(), KeyConditionExpression: "userId = :u",
    ExpressionAttributeValues: { ":u": session.Item.userId }, ScanIndexForward: false, Limit: 15 }));
  return response(200, { notifications: result.Items || [] });
}

async function startOAuth() {
  const state = crypto.randomBytes(32).toString("hex");
  await ddb.send(new PutCommand({TableName:process.env.STATE_TABLE,
    Item:{state, expiresAt:Math.floor(Date.now()/1000)+600}}));
  const client=oauth();
  const url=client.generateAuthUrl({access_type:"offline", prompt:"consent", include_granted_scopes:true, scope:scopes, state});
  return redirect(url);
}

async function callback(event) {
  const {code,state,error}=event.queryStringParameters || {};
  if(error) return redirect(`${process.env.FRONTEND_URL}/?oauth_error=${encodeURIComponent(error)}`);
  if(!code || !state) return response(400,{error:"Missing OAuth code/state"});
  const stateRecord=await ddb.send(new GetCommand({TableName:process.env.STATE_TABLE,Key:{state},ConsistentRead:true}));
  if(!stateRecord.Item || stateRecord.Item.expiresAt < Math.floor(Date.now()/1000))
    return response(400,{error:"Invalid or expired OAuth state"});
  await ddb.send(new DeleteCommand({TableName:process.env.STATE_TABLE,Key:{state}}));

  const client=oauth();
  const {tokens}=await client.getToken(code);
  if(!tokens.id_token) return response(400,{error:"Google ID token missing"});
  const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:process.env.GOOGLE_CLIENT_ID});
  const payload=ticket.getPayload();
  if(!payload?.sub || !payload?.email) return response(400,{error:"Google identity not verified"});

  let encryptedRefreshToken;
  if(tokens.refresh_token) {
    const encrypted=await kms.send(new EncryptCommand({
      KeyId:process.env.KMS_KEY_ID,
      Plaintext:Buffer.from(tokens.refresh_token),
      EncryptionContext:{userId:payload.sub, purpose:"gmail-refresh-token"}
    }));
    encryptedRefreshToken=Buffer.from(encrypted.CiphertextBlob).toString("base64");
  }

  const prior=await ddb.send(new GetCommand({TableName:process.env.TOKEN_TABLE,Key:{userId:payload.sub}}));
  await ddb.send(new PutCommand({TableName:process.env.TOKEN_TABLE,Item:{
    userId:payload.sub,email:payload.email,name:payload.name || "",
    encryptedRefreshToken:encryptedRefreshToken || prior.Item?.encryptedRefreshToken,
    scope:tokens.scope || scopes.join(" "),
    updatedAt:new Date().toISOString()
  }}));

  const savedTokenRecord = await ddb.send(new GetCommand({TableName:process.env.TOKEN_TABLE,Key:{userId:payload.sub}}));
  try { await registerGmailWatch(savedTokenRecord.Item); }
  catch (watchError) { console.error("Gmail watch registration failed; user can still use inbox", watchError?.message || "unknown error"); }

  const sessionId=crypto.randomBytes(32).toString("hex");
  await ddb.send(new PutCommand({TableName:process.env.SESSION_TABLE,Item:{
    sessionId,userId:payload.sub,email:payload.email,
    expiresAt:Math.floor(Date.now()/1000)+60*60*8
  }}));
  return redirect(`${process.env.FRONTEND_URL}/inbox`,{
    "Set-Cookie":`${cookieName}=${sessionId}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=28800`
  });
}

async function inbox(event) {
  const sessionId=getCookie(event,cookieName);
  if(!sessionId) return response(401,{error:"Sign in required"});
  const session=await ddb.send(new GetCommand({TableName:process.env.SESSION_TABLE,Key:{sessionId}}));
  if(!session.Item || session.Item.expiresAt < Math.floor(Date.now()/1000))
    return response(401,{error:"Session expired"});
  const tokenRecord=await ddb.send(new GetCommand({TableName:process.env.TOKEN_TABLE,Key:{userId:session.Item.userId}}));
  if(!tokenRecord.Item?.encryptedRefreshToken)
    return response(401,{error:"Google connection missing. Reconnect Google."});

  const encrypted=Buffer.from(tokenRecord.Item.encryptedRefreshToken,"base64");
  const decrypted=await kms.send(new DecryptCommand({
    KeyId:process.env.KMS_KEY_ID,
    CiphertextBlob:encrypted,
    EncryptionContext:{userId:session.Item.userId,purpose:"gmail-refresh-token"}
  }));
  const client=oauth();
  client.setCredentials({refresh_token:Buffer.from(decrypted.Plaintext).toString()});
  const gmail=google.gmail({version:"v1",auth:client});
  const list=await gmail.users.messages.list({userId:"me",labelIds:["INBOX"],maxResults:20});
  const ids=list.data.messages || [];
  const messages=await Promise.all(ids.slice(0,20).map(async m=>{
    const detail=await gmail.users.messages.get({userId:"me",id:m.id,format:"metadata",metadataHeaders:["From","Subject","Date"]});
    const headers=detail.data.payload?.headers || [];
    const find=(name)=>headers.find(h=>h.name?.toLowerCase()===name.toLowerCase())?.value || "";
    return {id:m.id,from:find("From"),subject:find("Subject"),date:find("Date"),snippet:detail.data.snippet || ""};
  }));
  return response(200,{user:{email:session.Item.email},messages});
}


async function getAuthedGmail(event) {
  const sessionId=getCookie(event,cookieName);
  if(!sessionId) throw Object.assign(new Error("Sign in required"),{statusCode:401});
  const session=await ddb.send(new GetCommand({TableName:process.env.SESSION_TABLE,Key:{sessionId}}));
  if(!session.Item || session.Item.expiresAt < Math.floor(Date.now()/1000))
    throw Object.assign(new Error("Session expired"),{statusCode:401});
  const tokenRecord=await ddb.send(new GetCommand({TableName:process.env.TOKEN_TABLE,Key:{userId:session.Item.userId}}));
  if(!tokenRecord.Item?.encryptedRefreshToken) throw Object.assign(new Error("Google connection missing"),{statusCode:401});
  const decrypted=await kms.send(new DecryptCommand({
    KeyId:process.env.KMS_KEY_ID,
    CiphertextBlob:Buffer.from(tokenRecord.Item.encryptedRefreshToken,"base64"),
    EncryptionContext:{userId:session.Item.userId,purpose:"gmail-refresh-token"}
  }));
  const client=oauth();
  client.setCredentials({refresh_token:Buffer.from(decrypted.Plaintext).toString()});
  return {gmail:google.gmail({version:"v1",auth:client}),session:session.Item};
}

async function sendEmail(event) {
  const {gmail,session}=await getAuthedGmail(event);
  let body;
  try { body=JSON.parse(event.body || "{}"); } catch { return response(400,{error:"Invalid JSON"}); }
  const to=String(body.to || "").trim();
  const subject=String(body.subject || "").trim();
  const text=String(body.body || "").trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject || !text)
    return response(400,{error:"Enter a valid recipient, subject, and message."});
  if(to.length>254 || subject.length>200 || text.length>10000)
    return response(400,{error:"Email fields exceed allowed length."});
  const safe=(v)=>Buffer.from(v,"utf8").toString("base64");
  const raw=[
    `To: ${to}`,
    `Subject: ${subject.replace(/[\r\n]/g," ")}`,
    `Reply-To: ${session.email}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    safe(text)
  ].join("\r\n");
  const encoded=Buffer.from(raw).toString("base64url");
  const result=await gmail.users.messages.send({userId:"me",requestBody:{raw:encoded}});
  return response(200,{ok:true,messageId:result.data.id,threadId:result.data.threadId});
}

async function logout(event) {
  const sessionId=getCookie(event,cookieName);
  if(sessionId) await ddb.send(new DeleteCommand({TableName:process.env.SESSION_TABLE,Key:{sessionId}}));
  return response(200,{ok:true},{"Set-Cookie":`${cookieName}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`});
}

export const handler = async (event) => {
  try {
    if (event.source === "aws.events" || event["detail-type"] === "Scheduled Event") {
      const count = await renewAllWatches();
      return { statusCode: 200, body: JSON.stringify({ renewed: count }) };
    }
    const path=event.path || event.rawPath || "";
    if(path.endsWith("/oauth/google") && event.httpMethod==="GET") return await startOAuth();
    if(path.endsWith("/oauth/google/callback") && event.httpMethod==="GET") return await callback(event);
    if(path.endsWith("/inbox") && event.httpMethod==="GET") return await inbox(event);
    if(path.endsWith("/send") && event.httpMethod==="POST") return await sendEmail(event);
    if(path.endsWith("/notifications") && event.httpMethod==="GET") return await getNotifications(event);
    if(path.endsWith("/pubsub/gmail") && event.httpMethod==="POST") return await pubsubPush(event);
    if(path.endsWith("/logout")) return await logout(event);
    return response(404,{error:"Not found"});
  } catch(e) {
    console.error("Request failed", e?.name || "Error"); // Do not log tokens or request bodies.
    return response(500,{error:"Internal server error"});
  }
};
