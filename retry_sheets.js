import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2Khaz.github.io/game-rank-dashboard/';
const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendDiscordAlert(message) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: message })
        });
    } catch (e) {
        console.error("디스코드 알림 전송 실패:", e.message);
    }
}

async function writePendingData() {
    const pendingFile = path.join(process.cwd(), 'pending_sheets.json');
    if (!fs.existsSync(pendingFile)) {
        console.log("No pending data to process.");
        return;
    }

    let pendingQueue = [];
    try {
        const rawData = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        // 🚀 [신의 한 수 백신 1] 대괄호 [ ] 없이 단일 객체 { }만 넣어도 무조건 배열로 스마트 자동 변환!!!
        pendingQueue = Array.isArray(rawData) ? rawData : [rawData];
    } catch (e) {
        console.error("Failed to parse pending_sheets.json:", e.message);
        process.exit(1);
    }

    if (pendingQueue.length === 0) {
        console.log("Pending queue is empty. No Discord alert sent.");
        return;
    }

    console.log(`Found ${pendingQueue.length} pending items. Attempting to write to Google Sheets...`);

    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("credentials.json not found.");
        process.exit(1);
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("Failed to parse credentials.json (Check GCP_CREDENTIALS secret):", e.message);
        process.exit(1);
    }

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    const retries = 5; 
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`구글 시트 접속 중... (시도 ${attempt}/${retries})`);
            await doc.loadInfo();
            console.log(`문서 로드됨: ${doc.title}`);

            let successCount = 0;

            for (const item of pendingQueue) {
                // 🚀 [신의 한 수 백신 2] 모든 가능한 날짜 필드명 완벽 커버 및 undefined 탭 생성 원천 차단!
                const nowStr = item.lastUpdated || item.timestamp || item.date || item.nowStr; 
                if (!nowStr) {
                    console.error("❌ 날짜(lastUpdated/timestamp) 필드를 찾을 수 없는 데이터입니다. (undefined 탭 생성 차단)");
                    continue;
                }

                const tempStr = `${nowStr}_temp_${Date.now().toString().slice(-4)}`; 
                let tempSheet;

                try {
                    console.log(`[1단계] 충돌 방지용 임시 탭('${tempStr}') 생성 중...`);
                    tempSheet = await doc.addSheet({ title: tempStr, gridProperties: { rowCount: 105, columnCount: 10 } });
                    await delay(5000); 

                    await tempSheet.loadCells('A1:H102');

                    const headers = [
                        "순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "",
                        "순위", "구글(한국) 게임명", "구글(한국) 개발사"
                    ];

                    const a1 = tempSheet.getCell(0, 0);
                    a1.formula = `=HYPERLINK("${DASHBOARD_URL}", "🖥️ 웹 대시보드 열기")`;
                    a1.textFormat = { bold: true, fontSize: 12 };
                    a1.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

                    for(let c = 0; c < headers.length; c++) {
                        const cell = tempSheet.getCell(1, c);
                        cell.value = headers[c];
                        cell.textFormat = { bold: true };
                        cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
                    }

                    const steamData = item.steamGlobal || [];
                    const googleData = item.playKr || item.googlePlay || [];

                    for (let i = 0; i < 100; i++) {
                        const rowIdx = i + 2;
                        if (i < steamData.length) {
                            tempSheet.getCell(rowIdx, 0).value = i + 1;
                            tempSheet.getCell(rowIdx, 1).value = steamData[i].name || '';
                            tempSheet.getCell(rowIdx, 2).value = steamData[i].developer || '';
                        }
                        if (i < googleData.length) {
                            tempSheet.getCell(rowIdx, 4).value = i + 1;
                            tempSheet.getCell(rowIdx, 5).value = googleData[i].title || googleData[i].name || '';
                            tempSheet.getCell(rowIdx, 6).value = googleData[i].developer || '';
                        }
                    }

                    console.log(`[2단계] 임시 탭에 셀 데이터 저장 중...`);
                    await tempSheet.saveUpdatedCells();
                    await delay(5000); 

                    // [3단계] 기존 탭 완전 삭제 및 10초 대기
                    await doc.loadInfo();
                    const existingSheet = doc.sheetsByTitle[nowStr];
                    if (existingSheet) {
                        console.log(`[3단계] 기존 탭('${nowStr}') 삭제 중... (완전 청소를 위해 10초 대기합니다)`);
                        await existingSheet.delete();
                        await delay(10000); 
                    }

                    // [4단계] 이름 변경 실패 시 5초 대기 후 재시도하는 2중 안전장치
                    try {
                        console.log(`[4단계] 임시 탭 이름을 '${nowStr}'(으)로 변경 시도 1...`);
                        await tempSheet.updateProperties({ title: nowStr });
                    } catch (renameErr) {
                        console.warn(`이름 변경 1차 실패 (삭제 지연 감지). 5초 대기 후 2차 시도합니다: ${renameErr.message}`);
                        await delay(5000);
                        await doc.loadInfo(); 
                        await tempSheet.updateProperties({ title: nowStr });
                    }

                    console.log(`[성공] '${nowStr}' 탭 이름 변경 완벽 완료.`);
                    successCount++;
                    await delay(5000); 

                } catch (err) {
                    console.error(`[오류] '${nowStr}' 탭 복구 중 실패:`, err.message);
                    throw err; 
                }
            }

            // ---------------------------------------------------------
            // [전체 탭 완벽한 날짜순 오름차순 정렬 로직]
            // ---------------------------------------------------------
            if (successCount > 0) {
                try {
                    console.log("전체 시트 탭 날짜순 정렬을 시작합니다...");
                    await doc.loadInfo(); 
                    
                    const sheets = doc.sheetCount ? [...doc.sheetsByIndex] : [];
                    const parsedSheets = sheets.map(s => {
                        const title = s.title;
                        const cleanTitle = title.length === 13 ? `${title}:00` : title;
                        const time = new Date(cleanTitle).getTime();
                        return { sheet: s, time: isNaN(time) ? 0 : time };
                    });

                    parsedSheets.sort((a, b) => a.time - b.time);

                    for (let i = 0; i < parsedSheets.length; i++) {
                        const currentSheet = parsedSheets[i].sheet;
                        if (currentSheet.index !== i) {
                            console.log(`[정렬 중] '${currentSheet.title}' 탭을 올바른 위치(${i + 1}번째)로 이동합니다...`);
                            await currentSheet.updateProperties({ index: i });
                            await delay(4000); 
                        }
                    }
                    console.log("전체 탭 날짜순 오름차순 정렬 완벽 완료.");
                } catch (sortErr) {
                    console.error("시트 탭 정렬 중 오류 발생 (데이터는 정상 유지됨):", sortErr.message);
                }
            }

            if (successCount > 0) {
                fs.writeFileSync(pendingFile, '[]');
                console.log("Successfully wrote pending data and cleared local JSON.");
                await sendDiscordAlert(`✅ [구글 시트 누락 복구 완료] ${successCount}건의 대기 데이터가 복구되었습니다.`);
                return; 
            } else {
                console.log("No items were successfully written in this attempt.");
                throw new Error("성공한 시트 복구 건수가 0건입니다.");
            }

        } catch (e) {
            console.error(`[Google Sheets] 처리 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) {
                console.log("10초 대기 후 재시도합니다...");
                await delay(10000); 
            }
        }
    }

    console.error("❌ 구글 시트 복구 최종 실패 (5회 시도 초과).");
    process.exit(1);
}

writePendingData();
