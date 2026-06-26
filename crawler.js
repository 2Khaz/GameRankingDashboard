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
    console.log("스팀(한국) 최고 매출 데이터 가져오는 중..");
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch("https://store.steampowered.com/search/results/?query&start=0&count=100&filter=topsellers&infinite=1&cc=kr&l=koreana", {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                }
            });
            const data = await res.json();
            const $ = cheerio.load(data.results_html);
            
            const games = [];
            $('a.search_result_row').each((i, el) => {
                const title = $(el).find('.title').text().trim();
                const appIdRaw = $(el).attr('data-ds-appid');
                const appId = appIdRaw ? appIdRaw.split(',')[0] : null;
                games.push({ name: title, appId: appId, developer: '-', genre: '기본', price: null });
            });

            if (games.length === 0) throw new Error("스팀 데이터가 0건입니다.");
            
            console.log(`[Steam] 데이터 ${games.length}건 성공! 개발사/장르/가격 정보 추가 중(약 10~15초 소요)...`);
            const batchSize = 10;
            for (let i = 0; i < Math.min(100, games.length); i += batchSize) {
                const batch = games.slice(i, i + batchSize);
                await Promise.all(batch.map(async (game) => {
                    if (game.appId) {
                        try {
                            const appRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${game.appId}&cc=kr&l=koreana`, {
                                headers: { 'User-Agent': 'Mozilla/5.0' }
                            });
                            const appData = await appRes.json();
                            if (appData && appData[game.appId] && appData[game.appId].success) {
                                const detail = appData[game.appId].data;
                                const devs = detail.developers;
                                if (devs && devs.length > 0) game.developer = devs[0];
                                const genres = detail.genres;
                                if (genres && genres.length > 0) game.genre = genres[0].description;
                                if (detail.header_image) game.icon = detail.header_image;

                                if (detail.is_free) {
                                    game.price = { final: '무료 (Free)', isFree: true, isDiscounted: false };
                                } else if (detail.price_overview) {
                                    const price = detail.price_overview;
                                    const finalFormatted = price.final_formatted || `₩ ${(price.final / 100).toLocaleString()}`;
                                    const initialFormatted = price.initial_formatted || finalFormatted;
                                    game.price = { initial: initialFormatted, final: finalFormatted, discountPercent: price.discount_percent || 0, isDiscounted: price.discount_percent > 0 };
                                } else {
                                    game.price = { final: '가격 정보 없음', isDiscounted: false };
                                }
                            }
                        } catch (err) {}
                    }
                }));
                await delay(500);
            }
            return games.slice(0, 100);
        } catch (e) {
            console.error(`[Steam] 데이터 오류 (시도 ${attempt}/${retries}):`, e.message);
            await sendDiscordAlert(`🚨 **[Steam] 데이터 수집 오류!**\n\`${e.message}\``);
            if (attempt < retries) await delay(3000);
        }
    }
    return [];
}

async function fetchPlayStore(country = 'kr', lang = 'ko', retries = 3) {
    console.log(`구글 플레이스토어(${country}) 최고 매출 데이터 가져오는 중..`);
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const data = await gplay.list({ collection: gplay.collection.GROSSING, category: gplay.category.GAME, num: 100, country: country, lang: lang });
            if (data && data.length > 0) {
                console.log(`[PlayStore] 데이터 ${data.length}건 성공! 장르 정보 추가 중(약 10~15초 소요)...`);
                const games = data.map(item => ({ title: item.title, appId: item.appId, developer: item.developer, icon: item.icon, genre: '기본' }));
                const batchSize = 10;
                for (let i = 0; i < Math.min(100, games.length); i += batchSize) {
                    const batch = games.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (game) => {
                        try {
                            const appDetail = await gplay.app({ appId: game.appId, lang: lang, country: country });
                            if (appDetail && appDetail.genre) game.genre = appDetail.genre;
                        } catch (err) {}
                    }));
                    await delay(500);
                }
                return games;
            }
            throw new Error("구글 플레이 데이터가 0건입니다.");
        } catch (e) {
            console.error(`[PlayStore] 데이터 오류 (시도 ${attempt}/${retries}):`, e.message);
            await sendDiscordAlert(`🚨 **[PlayStore] 데이터 수집 오류!**\n\`${e.message}\``);
            if (attempt < retries) await delay(3000);
        }
    }
    return [];
}

function enrichDataWithRankAndStreak(currentList, platformName, previousData, streaks) {
    const previousRanks = {};
    if (previousData) {
        previousData.forEach((g, index) => {
            const id = g.appId || g.title || g.name;
            previousRanks[id] = index + 1;
        });
    }

    currentList.forEach((game, index) => {
        const id = game.appId || game.title || game.name;
        const currentRank = index + 1;
        
        if (previousRanks[id]) {
            game.rankChange = previousRanks[id] - currentRank;
        } else {
            game.rankChange = 'new';
        }

        const newStreakKey = `${platformName}_${id}`;
        const oldStreakKey = `${platformName}_${game.title || game.name}`;

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
        console.error("❌ 치명적 오류: credentials.json 파일이 없습니다. 깃허브 Secret 설정을 확인하세요.");
        return false;
    }

    let creds;
    try {
        const credsRaw = fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8');
        creds = JSON.parse(credsRaw);
    } catch (e) {
        console.error("❌ 치명적 오류: credentials.json 파싱 실패:", e.message);
        return false;
    }

    const jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
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
                if (sheet) await sheet.delete();
            } catch(e) {}

            console.log(`'${nowStr}' 이름의 새 시트 생성 중...`);
            sheet = await doc.addSheet({ title: nowStr, gridProperties: { rowCount: 105, columnCount: 10 } });
            
            await sheet.loadCells('A1:H102');

            const headers = ["순위", "스팀(한국) 게임명", "스팀(한국) 개발사", "스팀 가격 / 할인율", "순위", "구글(한국) 게임명", "구글(한국) 개발사"];
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
            if (attempt < retries) await delay(5000);
        }
    }
    console.error("❌ 구글 시트 저장 최종 실패. 데이터를 저장하지 않고 작업을 취소합니다.");
    return false;
}

async function saveHistory(nowStr, steamGlobal, playKr) {
    const dashboardData = { lastUpdated: nowStr, steamGlobal: steamGlobal, playKr: playKr };
    fs.writeFileSync('data.json', JSON.stringify(dashboardData, null, 2), 'utf8');
    
    const historyDir = path.join(process.cwd(), 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    
    const dateStr = nowStr.replace(' ', '_'); 
    const historyFile = path.join(historyDir, `${dateStr}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(dashboardData, null, 2), 'utf8');
    
    const listFile = path.join(historyDir, 'history_list.json');
    let historyList = [];
    if (fs.existsSync(listFile)) historyList = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    if (!historyList.includes(dateStr)) historyList.push(dateStr);
    
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
    const nowStr = kst.toISOString().replace(/T/, ' ').substring(0, 13);

    const [steamGlobal, playKr] = await Promise.all([
        fetchSteamGlobal(3),
        fetchPlayStore('kr', 'ko', 3)
    ]);

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
        } catch(e) {}
    }

    const streaksFile = path.join(historyDir, 'game_streaks.json');
    let streaks = {};
    if (fs.existsSync(streaksFile)) {
        try { streaks = JSON.parse(fs.readFileSync(streaksFile, 'utf8')); } catch(e) {}
    }

    enrichDataWithRankAndStreak(steamGlobal, 'steam', previousSteam, streaks);
    enrichDataWithRankAndStreak(playKr, 'play', previousPlay, streaks);
    cleanupStreaks(steamGlobal, playKr, streaks);

    // 1. 구글 시트 저장 시도 (성공 여부를 먼저 판별)
    const isSheetSuccess = await writeToGoogleSheets(nowStr, steamGlobal, playKr, 5);

    // 2. 구글 시트 저장 실패 시 전면 롤백 (로컬 파일 및 json 기록 취소)
    if (!isSheetSuccess) {
        await sendDiscordAlert(`🚨 **크롤링 전체 실패 (작업 롤백됨)**\n시간: \`${nowStr}\`\n구글 시트 저장에 실패하여 JSON 파일 및 역사 기록을 업데이트하지 않고 작업을 전면 취소했습니다.`);
        console.error("❌ 구글 시트 저장 실패로 인해 전체 프로세스를 중단합니다. (데이터 변경 없음)");
        return; // 여기서 return 하므로 아래 로컬 기록(JSON, 연승점수 등)은 절대 실행되지 않음
    }

    // 3. 시트 저장이 완벽히 성공했을 때만 streaks 데이터와 로컬 히스토리 파일 덮어쓰기
    fs.writeFileSync(streaksFile, JSON.stringify(streaks, null, 2), 'utf8');
    await saveHistory(nowStr, steamGlobal, playKr);

    // 4. 최종 성공 알림
    await sendDiscordAlert(`✅ **크롤링 성공!**\n시간: \`${nowStr}\`\n구글 시트 및 웹 대시보드 데이터 저장이 모두 무사히 완료되었습니다.`);
    console.log("✅ 모든 크롤링 프로세스가 완료되었습니다!");
}

main().catch(console.error);
