require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cheerio = require('cheerio');
const gplay = require('google-play-scraper');

const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'credentials.json');
const spreadsheetId = process.env.SPREADSHEET_ID;
const DASHBOARD_URL = "https://hyg92.github.io/game-rank-dashboard/";

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSteamGlobal(retries = 3) {
    console.log("스팀(한국) 최고 매출 데이터 가져오는 중...");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch("https://store.steampowered.com/search/results/?query&start=0&count=100&filter=topsellers&infinite=1&cc=kr&l=koreana", {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    // [해결포인트 2번] 스팀 성인 게임 누락 문제 해결
                    // 스팀 놀이공원의 성인 인증을 통과하기 위해, 크롤러에게 1980년생이라는 어른 신분증(쿠키)을 쥐여줍니다.
                    // 이 쿠키 덕분에 '서큐버스 계승자' 같은 성인 게임도 숨겨지지 않고 정상적으로 긁어오게 됩니다!
                    'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                }
            });
            const data = await res.json();
            const $ = cheerio.load(data.results_html);
            
            const results = [];
            $('.search_result_row').each((i, el) => {
                const name = $(el).find('.title').text().trim();
                const appId = $(el).attr('data-ds-appid');
                const priceHtml = $(el).find('.discount_final_price').text().trim();
                const initialPriceHtml = $(el).find('.discount_original_price').text().trim();
                const discountHtml = $(el).find('.discount_pct').text().trim();
                const icon = $(el).find('img').attr('src');
                
                let price = null;
                if (priceHtml) {
                    if (priceHtml.includes('무료') || priceHtml.toLowerCase().includes('free')) {
                        price = { isFree: true, final: '무료' };
                    } else {
                        price = {
                            isFree: false,
                            final: priceHtml,
                            initial: initialPriceHtml || priceHtml,
                            discountPercent: discountHtml ? parseInt(discountHtml.replace('-', '').replace('%', '')) : 0,
                            isDiscounted: !!discountHtml
                        };
                    }
                }

                results.push({
                    name,
                    appId,
                    price,
                    icon,
                    developer: '', 
                    genre: ''
                });
            });

            // 스팀 세부 정보 (개발사, 장르) 가져오기 - 5개씩 병렬 처리하여 속도 최적화
            const batchSize = 5;
            for (let i = 0; i < results.length; i += batchSize) {
                const batch = results.slice(i, i + batchSize);
                await Promise.all(batch.map(async (game) => {
                    if (game.appId) {
                        try {
                            const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&cc=kr&l=koreana`, {
                                headers: {
                                    'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                                }
                            });
                            const appData = await appRes.json();
                            if (appData[game.appId] && appData[game.appId].success) {
                                const details = appData[game.appId].data;
                                game.developer = details.developers ? details.developers.join(', ') : '알 수 없음';
                                game.genre = details.genres ? details.genres[0].description : '기타';
                            }
                        } catch(e) {}
                    }
                }));
                if (i + batchSize < results.length) await delay(500); 
            }

            console.log(`[Steam] ${results.length}개 게임 가져오기 완료.`);
            return results;
        } catch (e) {
            console.error(`[Steam] 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) await delay(3000); // 3초 대기 후 재시도
        }
    }
    return [];
}

async function fetchPlayStore(country = 'kr', lang = 'ko', retries = 3) {
    console.log(`구글 플레이스토어(${country}) 최고 매출 데이터 가져오는 중...`);
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const data = await gplay.list({ collection: gplay.collection.GROSSING, category: gplay.category.GAME, num: 100, country: country, lang: lang });
            if (data && data.length > 0) {
                const results = data.map(app => ({
                    title: app.title,
                    developer: app.developer,
                    icon: app.icon,
                    appId: app.appId,
                    genre: app.genre || '기타'
                }));
                console.log(`[PlayStore] ${results.length}개 게임 가져오기 완료.`);
                return results;
            }
        } catch (e) {
            console.error(`[PlayStore] 실패 (시도 ${attempt}/${retries}):`, e.message);
            if (attempt < retries) await delay(3000); 
        }
    }
    return [];
}

function enrichDataWithRankAndStreak(currentList, platformName, previousData, streaks) {
    const previousRanks = {};
    if (previousData) {
        previousData.forEach((g, index) => {
            // [해결포인트 1번-1] 이름 대신 고유 번호(appId)를 사용해 어제 순위를 기억합니다.
            const id = g.appId || g.title || g.name;
            previousRanks[id] = index + 1;
        });
    }

    currentList.forEach((game, index) => {
        // [해결포인트 1번-2] 오늘 순위 변동 계산 시에도 고유 번호(appId)를 기준으로 찾습니다.
        const id = game.appId || game.title || game.name;
        const currentRank = index + 1;
        
        if (previousRanks[id]) {
            game.rankChange = previousRanks[id] - currentRank; // 양수면 상승, 음수면 하락
        } else {
            game.rankChange = 'new'; // 새로 진입
        }

        // [해결포인트 1번-3] 기존 점수 마이그레이션 및 누적 로직
        const newStreakKey = `${platformName}_${id}`;
        const oldStreakKey = `${platformName}_${game.title || game.name}`;

        // 혹시 단골 명단에 옛날 이름표(oldStreakKey)로 쌓은 점수가 있다면, 새 이름표(newStreakKey)로 고스란히 옮깁니다!
        if (streaks[oldStreakKey] !== undefined && newStreakKey !== oldStreakKey) {
            streaks[newStreakKey] = streaks[oldStreakKey];
            delete streaks[oldStreakKey];
        }

        if (streaks[newStreakKey]) {
            streaks[newStreakKey] += 1;
        } else {
            streaks[newStreakKey] = 1;
        }
        game.streak = streaks[newStreakKey];
    });

    return currentList;
}

function cleanupStreaks(currentSteam, currentPlay, streaks) {
    const activeKeys = new Set();
    // [해결포인트 1번-4] 100위 밖으로 나간 게임들 점수를 지울 때도, 고유 번호(appId) 기준으로 확인합니다.
    currentSteam.forEach(g => activeKeys.add(`steam_${g.appId || g.name}`));
    currentPlay.forEach(g => activeKeys.add(`play_${g.appId || g.title}`));

    for (let key in streaks) {
        if (!activeKeys.has(key)) {
            delete streaks[key];
        }
    }
}

async function writeToGoogleSheets(nowStr, steamGlobal, playKr, retries = 5) {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        console.error("경고: credentials.json 파일이 없습니다. 구글 시트 저장을 건너뜁니다.");
        return;
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("경고: credentials.json 파싱 실패:", e.message);
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
            console.log(`구글 시트 연결 중... (시도 ${attempt}/${retries})`);
            await doc.loadInfo(); 
            console.log(`시트 제목: ${doc.title}`);

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

            // 4번째 열에 '스팀 가격 / 할인율' 칼럼 추가
            const headers = [
                "순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "스팀 가격 / 할인율",
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
                    if (steamGlobal[i].price) {
                        const p = steamGlobal[i].price;
                        sheet.getCell(rowIdx, 3).value = p.isDiscounted ? `${p.final} (-${p.discountPercent}%)` : p.final;
                    } else {
                        sheet.getCell(rowIdx, 3).value = '-';
                    }
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
            return true;
        } catch (e) {
            console.error(`[Google Sheets] 저장 실패 (시도 ${attempt}/${retries}):`, e.message);
            await sendDiscordAlert(`🚨 **[Google Sheets] 기록 오류!**\n\`${e.message}\``);
            if (attempt < retries) await delay(5000); // 5초 대기 후 재시도
        }
    }
    console.error("❌ 구글 시트 저장 최종 실패. 대시보드 파일만 저장합니다.");
    return false;
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
    
    // YYYY-MM-DD_HH 형태로 시간 단위까지 포함하여 저장
    const dateStr = nowStr.replace(' ', '_'); 
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
    // 최신 날짜가 맨 위로 오게 정렬 (정상 시간 문자열 파싱 패치)
    historyList.sort((a, b) => new Date(b.replace('_', 'T') + ':00') - new Date(a.replace('_', 'T') + ':00'));
    fs.writeFileSync(listFile, JSON.stringify(historyList, null, 2), 'utf8');

    console.log(`✅ 대시보드 데이터 저장 완료! (data.json 및 history/${dateStr}.json)`);
}

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

async function main() {
    const now = new Date();
    const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13); // 'YYYY-MM-DD HH'

    const [steamGlobal, playKr] = await Promise.all([
        fetchSteamGlobal(3),
        fetchPlayStore('kr', 'ko', 3)
    ]);

    // ------ 장르/순위변동/장기흥행 처리 (구글 시트에 영향 안 줌) ------
    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);

    let previousSteam = [];
    let previousPlay = [];
    
    const listFile = path.join(historyDir, 'history_list.json');
    if (fs.existsSync(listFile)) {
        try {
            const historyList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
            if (historyList.length > 0) {
                const lastHistoryName = historyList[0];
                const lastHistoryFile = path.join(historyDir, `${lastHistoryName}.json`);
                if (fs.existsSync(lastHistoryFile)) {
                    const lastData = JSON.parse(fs.readFileSync(lastHistoryFile, 'utf8'));
                    previousSteam = lastData.steamGlobal || [];
                    previousPlay = lastData.playKr || [];
                }
            }
        } catch(e) { console.error("이전 기록 로딩 실패:", e); }
    }

    const streaksFile = path.join(historyDir, 'game_streaks.json');
    let streaks = {};
    if (fs.existsSync(streaksFile)) {
        try {
            streaks = JSON.parse(fs.readFileSync(streaksFile, 'utf8'));
        } catch(e) {}
    }

    enrichDataWithRankAndStreak(steamGlobal, 'steam', previousSteam, streaks);
    enrichDataWithRankAndStreak(playKr, 'play', previousPlay, streaks);
    cleanupStreaks(steamGlobal, playKr, streaks);

    fs.writeFileSync(streaksFile, JSON.stringify(streaks, null, 2), 'utf8');
    // -------------------------------------------------------------

    // 1. 구글 시트 저장
    const isSheetSuccess = await writeToGoogleSheets(nowStr, steamGlobal, playKr, 5);

    if (!isSheetSuccess) {
        const pendingFile = path.join(process.cwd(), 'pending_sheets.json');
        let pendingQueue = [];
        if (fs.existsSync(pendingFile)) {
            try { pendingQueue = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch(e) {}
        }
        pendingQueue.push({
            timestamp: nowStr,
            steamGlobal: steamGlobal,
            playKr: playKr
        });
        fs.writeFileSync(pendingFile, JSON.stringify(pendingQueue, null, 2), 'utf8');

        await sendDiscordAlert(`🚨 **크롤링 부분 성공 (구글 시트 실패)**\n시간: \`${nowStr}\`\n구글 시트 저장에 실패하여 임시 보관함에 저장했습니다. 몇 시간 뒤 자동 재시도됩니다.`);
        console.error("❌ 구글 시트 저장 실패. 데이터를 임시 보관함에 저장하고 대시보드 업데이트를 진행합니다.");
    }

    // 2. 히스토리 데이터 로컬 저장
    await saveHistory(nowStr, steamGlobal, playKr);

    // 3. 성공 알림 전송
    if (isSheetSuccess) {
        await sendDiscordAlert(`✅ **크롤링 완벽 성공!**\n시간: \`${nowStr}\`\n데이터 수집 및 저장이 무사히 완료되었습니다.`);
    }

    console.log("✅ 모든 크롤링 프로세스가 완료되었습니다!");
}

main().catch(console.error);
