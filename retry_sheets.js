import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2Khaz.github.io/game-rank-dashboard/';
const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

// [문제 2 해결] 구글 API 과부하 방지를 위한 2초 숨고르기(Throttle) 함수
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
        pendingQueue = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } catch (e) {
        console.error("Failed to parse pending_sheets.json");
        return;
    }

    if (pendingQueue.length === 0) {
        console.log("Pending queue is empty. No Discord alert sent.");
        return;
    }

    console.log(`Found ${pendingQueue.length} pending items. Attempting to write to Google Sheets...`);

    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("credentials.json not found.");
        return;
    }

    const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
    const creds = JSON.parse(credsRaw);
    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    
    try {
        await doc.loadInfo();
        console.log(`문서 로드됨: ${doc.title}`);

        let successCount = 0; // 성공적으로 복구된 탭 건수 추적

        // [문제 3 해결] 대기열의 각 탭 복구를 개별 try-catch로 격리하여 특정 탭 실패 시에도 중단 없이 계속 진행
        for (const item of pendingQueue) {
            const nowStr = item.timestamp; 
            let sheet;

            try {
                try {
                    sheet = doc.sheetsByTitle[nowStr];
                    if (sheet) {
                        await sheet.delete();
                    }
                } catch(e) {}

                console.log(`[복구 중] '${nowStr}' 이름의 새 시트 탭 생성 중...`);
                sheet = await doc.addSheet({ title: nowStr, gridProperties: { rowCount: 105, columnCount: 10 } });
                
                await sheet.loadCells('A1:H102');

                // 상단 A1 셀 대시보드 하이퍼링크 서식 지정
                const a1 = sheet.getCell(0, 0);
                a1.formula = `=HYPERLINK("${DASHBOARD_URL}", "🖥️ 웹 대시보드 열기")`;
                a1.textFormat = { bold: true, fontSize: 12 };
                a1.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

                // 헤더 컬럼 생성 (2번 행)
                const headers = [
                    "순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "",
                    "순위", "구글(한국) 게임명", "구글(한국) 개발사"
                ];
                for (let c = 0; c < headers.length; c++) {
                    const cell = sheet.getCell(1, c);
                    cell.value = headers[c];
                    cell.textFormat = { bold: true };
                    cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
                }

                // 스팀(steamGlobal) 및 구글(playKr) 데이터 좌우 분할 배치 (1~100위)
                const steamList = item.steamGlobal || [];
                const playList = item.playKr || [];

                for (let i = 0; i < 100; i++) {
                    const rowIdx = i + 2; 
                    if (i < steamList.length) {
                        sheet.getCell(rowIdx, 0).value = i + 1;
                        sheet.getCell(rowIdx, 1).value = steamList[i].name || '';
                        sheet.getCell(rowIdx, 2).value = steamList[i].developer || '';
                    }
                    if (i < playList.length) {
                        sheet.getCell(rowIdx, 4).value = i + 1;
                        sheet.getCell(rowIdx, 5).value = playList[i].title || '';
                        sheet.getCell(rowIdx, 6).value = playList[i].developer || '';
                    }
                }

                console.log(`[복구 중] '${nowStr}' 데이터를 구글 시트에 일괄 기록하는 중...`);
                await sheet.saveUpdatedCells();
                console.log(`✅ '${nowStr}' 시트 탭 복구 성공! (API 안정을 위해 2초 대기)`);
                
                successCount++;
                // [문제 2 해결] 구글 API 서버 429 과부하 방지를 위한 2초 숨고르기
                await delay(2000); 

            } catch (err) {
                console.error(`❌ '${nowStr}' 탭 복구 중 개별 에러 발생 (스킵 후 다음 건 진행): ${err.message}`);
                continue; // 에러 발생 시 알림 없이 다음 펜딩 건으로 조용히 넘어감
            }
        }

        // 시트 탭 날짜순 오름차순 정렬 (과거가 맨 좌측, 최신이 맨 우측)
        console.log("시트 탭 순서를 오름차순(과거->최신)으로 재정렬합니다...");
        await doc.loadInfo(); 
        
        const sortedSheets = [...doc.sheetsByIndex].sort((a, b) => {
            return a.title.localeCompare(b.title);
        });

        for (let i = 0; i < sortedSheets.length; i++) {
            if (sortedSheets[i].index !== i) {
                await sortedSheets[i].updateProperties({ index: i });
            }
        }
        console.log("✅ 시트 탭 날짜순(오름차순) 정렬 완료!");

        // [사용자 알림 조건 완벽 반영]: 성공적으로 펜딩 시트 추가 작업이 끝났을 때만 파일 비우기 및 디스코드 알림 발송
        if (successCount > 0) {
            fs.writeFileSync(pendingFile, '[]');
            console.log("Successfully wrote pending data and cleared local JSON.");

            // [문구 최적화]: 재정렬 내용을 제외하고 직관적이고 간결한 성공 메시지 발송
            await sendDiscordAlert(`✅ [구글 시트 누락 복구 완료] ${successCount}건의 대기 데이터가 복구되었습니다.`);
        } else {
            console.log("No items were successfully written. Pending file kept intact. No Discord alert sent.");
        }

    } catch (e) {
        // 도중 인증 실패 등 에러 발생 시, 디스코드 알림을 보내지 않고 로컬 펜딩 파일을 안전하게 유지
        console.error("Failed to connect or process Google Sheets:", e.message);
        return;
    }
}

writePendingData();
