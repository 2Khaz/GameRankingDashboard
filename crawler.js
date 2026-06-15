import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import gplay from 'google-play-scraper';
import * as cheerio from 'cheerio';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2Khaz.github.io/game-rank-dashboard/';

const spreadsheetId = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSteamGlobal(retries = 3) {
    console.log("스팀(한국) 최고 매출 데이터 가져오는 중...");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch("https://store.steampowered.com/search/results/?query&start=0&count=100&filter=topsellers&infinite=1&cc=kr", {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const data = await res.json();
            const $ = cheerio.load(data.results_html);
            
            const games = [];
            $('a.search_result_row').each((i, el) => {
                const title = $(el).find('.title').text().trim();
                const appIdRaw = $(el).attr('data-ds-appid');
                const appId = appIdRaw ? appIdRaw.split(',')[0] : null;
                games.push({
                    name: title,
                    appId: appId,
                    developer: '-'
                });
            });

            if (games.length === 0) throw new Error("스팀 데이터가 0건입니다.");
            
            console.log(`[Steam] 데이터 ${games.length}건 성공! 개발사 정보 추가 중 (약 10~15초 소요)...`);
            const batchSize = 10;
            for (let i = 0; i < Math.min(100, games.length); i += batchSize) {
                const batch = games.slice(i, i + batchSize);
                await Promise.all(batch.map(async (game) => {
                    if (game.appId) {
                        try {
                            const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&cc=kr`, {
                                headers: { 'User-Agent': 'Mozilla/5.0' }
                            });
                            const appData = await appRes.json();
                            if (appData && appData[game.appId] && appData[game.appId].success) {
                                const devs = appData[game.appId].data.developers;
                                if (devs && devs.length > 0) {
                                    game.developer = devs[0];
                                }
                            }
                        } catch (err) {}
                    }
                }));
                await delay(500); // Rate Limit 방지
            }
            
            return games.slice(0, 100);
        } catch (e) {
            console.error(`[Steam] 데이터 오류 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) await delay(3000); // 3초 대기 후 재시도
        }
    }
    return [];
}

async function fetchPlayStore(country = 'kr', lang = 'ko', retries = 3) {
    console.log(`구글 플레이스토어(${country}) 최고 매출 데이터 가져오는 중...`);
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const data = await gplay.list({
                collection: gplay.collection.GROSSING,
                category: gplay.category.GAME,
                num: 100,
                country: country,
                lang: lang
            });
            if (data && data.length > 0) {
                console.log(`[PlayStore] 데이터 ${data.length}건 성공!`);
                return data;
            }
            throw new Error("구글 플레이 데이터가 0건입니다.");
        } catch (e) {
            console.error(`[PlayStore] 데이터 오류 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) await delay(3000); // 3초 대기 후 재시도
        }
    }
    return [];
}

async function writeToGoogleSheets(nowStr, steamGlobal, playKr, retries = 5) {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("❌ 치명적 오류: credentials.json 파일이 없습니다. 깃허브 Secret 설정을 확인하세요.");
        return;
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("❌ 치명적 오류: credentials.json 파싱 실패 (열쇠 내용이 올바르지 않습니다):", e.message);
        return;
    }

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ]
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`구글 시트 접속 중... (시도 ${attempt}/${retries})`);
            await doc.loadInfo(); 
            console.log(`문서 로드됨: ${doc.title}`);

            let sheet;
            try {
                sheet = doc.sheetsByTitle[nowStr];
                if (sheet) {
                    await sheet.delete();
                }
            } catch(e) {}

            console.log(`'${nowStr}' 이름의 새 시트 생성 중...`);
            sheet = await doc.addSheet({ title: nowStr, gridProperties: { rowCount: 105, columnCount: 10 } });
            
            await sheet.loadCells('A1:H102');

            const headers = [
                "순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "",
                "순위", "구글(한국) 게임명", "구글(한국) 개발사"
            ];

            const a1 = sheet.getCell(0, 0);
            a1.formula = `=HYPERLINK("${DASHBOARD_URL}", "🖥️ 웹 대시보드 열기")`;
            a1.textFormat = { bold: true, fontSize: 12 };
            a1.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

            for(let c=0; c<headers.length; c++) {
                const cell = sheet.getCell(1, c);
                cell.value = headers[c];
                cell.textFormat = { bold: true };
                cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
            }

            for (let i = 0; i < 100; i++) {
                const rowIdx = i + 2;
                if (i < steamGlobal.length) {
                    sheet.getCell(rowIdx, 0).value = i + 1;
                    sheet.getCell(rowIdx, 1).value = steamGlobal[i].name || '';
                    sheet.getCell(rowIdx, 2).value = steamGlobal[i].developer || '';
                }
                if (i < playKr.length) {
                    sheet.getCell(rowIdx, 4).value = i + 1;
                    sheet.getCell(rowIdx, 5).value = playKr[i].title || '';
                    sheet.getCell(rowIdx, 6).value = playKr[i].developer || '';
                }
            }

            console.log("데이터를 구글 시트에 기록하는 중...");
            await sheet.saveUpdatedCells();
            console.log("✅ 구글 시트 저장 완료!");
            return; // 성공 시 함수 종료
        } catch (e) {
            console.error(`[Google Sheets] 저장 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) await delay(5000); // 5초 대기 후 재시도
        }
    }
    console.error("❌ 구글 시트 저장 최종 실패. 대시보드 파일만 저장합니다.");
}

async function saveHistory(nowStr, steamGlobal, playKr) {
    const dashboardData = {
        lastUpdated: nowStr,
        steamGlobal: steamGlobal,
        playKr: playKr
    };

    // 1. 현재 데이터 덮어쓰기 (기본용)
    fs.writeFileSync('data.json', JSON.stringify(dashboardData, null, 2), 'utf8');
    
    // 2. history 폴더에 날짜별 저장
    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir);
    }
    
    // YYYY-MM-DD 만 추출 (예: '2026-06-15 23' -> '2026-06-15')
    const dateStr = nowStr.split(' ')[0];
    const historyFile = path.join(historyDir, `${dateStr}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(dashboardData, null, 2), 'utf8');
    
    // 3. history_list.json 업데이트
    const listFile = path.join(historyDir, 'history_list.json');
    let historyList = [];
    if (fs.existsSync(listFile)) {
        historyList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    }
    if (!historyList.includes(dateStr)) {
        historyList.push(dateStr);
    }
    // 최신 날짜가 맨 위로 오게 정렬
    historyList.sort((a, b) => new Date(b) - new Date(a));
    fs.writeFileSync(listFile, JSON.stringify(historyList, null, 2), 'utf8');

    console.log(`✅ 대시보드 데이터 저장 완료! (data.json 및 history/${dateStr}.json)`);
}

async function main() {
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13); // 'YYYY-MM-DD HH'

    const [steamGlobal, playKr] = await Promise.all([
        fetchSteamGlobal(3), // 3회 재시도
        fetchPlayStore('kr', 'ko', 3) // 3회 재시도
    ]);

    // 1. 구글 시트 저장 (실패 시 5회 재시도, 치명적 인증 에러는 로깅)
    await writeToGoogleSheets(nowStr, steamGlobal, playKr, 5);

    // 2. 히스토리 데이터 로컬 저장
    await saveHistory(nowStr, steamGlobal, playKr);

    console.log("✅ 모든 크롤링 프로세스가 완료되었습니다!");
}

main().catch(console.error);
