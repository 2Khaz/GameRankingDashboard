import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import gplay from 'google-play-scraper';
import * as cheerio from 'cheerio';

const SERVICE_ACCOUNT_FILE = './credentials.json';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1ONFeWZTqMXIsWtx9xoRYxcW7lTde56yfvyKUXDi8c3c/edit?gid=1490331569#gid=1490331569';
const DASHBOARD_URL = 'https://2khaz.github.io/GameRankingDashboard/';
const TEST_PREFIX = '__SYSTEM_TEST__';
const TEST_WORK_ROOT = path.join(process.cwd(), '.system-test-work');
const MIN_EXPECTED_RESULTS = 5;
const FAILURE_ALERT_MARKER = path.join(
    process.env.RUNNER_TEMP || process.cwd(),
    'game-ranking-system-test-failure-alert-sent'
);
const DISCORD_MESSAGE_LIMIT = 2000;

const spreadsheetMatch = SPREADSHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/);
if (!spreadsheetMatch) {
    throw new Error('SPREADSHEET_URL에서 스프레드시트 ID를 찾지 못했습니다.');
}
const spreadsheetId = spreadsheetMatch[1];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function kstTimestamp() {
    const kst = new Date(Date.now() + (9 * 60 * 60 * 1000));
    return kst.toISOString().replace('T', ' ').slice(0, 19);
}

function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function redactSensitiveText(value) {
    let text = String(value ?? '알 수 없는 오류');
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) text = text.split(webhookUrl).join('[REDACTED_WEBHOOK]');
    return text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function truncateText(value, maxLength) {
    const text = redactSensitiveText(value);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function githubActionsRunUrl() {
    const server = process.env.GITHUB_SERVER_URL;
    const repository = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    return server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null;
}

function markFailureAlertSent() {
    try {
        fs.writeFileSync(FAILURE_ALERT_MARKER, kstTimestamp(), 'utf8');
    } catch (error) {
        console.warn(`⚠️ Discord 실패 알림 마커 생성 실패: ${safeErrorMessage(error)}`);
    }
}

async function withTimeout(promise, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 시간 초과 (${timeoutMs / 1000}초)`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function fetchJsonWithRetry(url, options, label, retries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(20_000)
            });

            if (!response.ok) {
                throw new Error(`${label} HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            lastError = error;
            console.error(`❌ ${label} 실패 (${attempt}/${retries}): ${safeErrorMessage(error)}`);
            if (attempt < retries) await delay(2_000 * attempt);
        }
    }

    throw lastError ?? new Error(`${label} 요청 실패`);
}

async function fetchSteamTop10() {
    console.log('▶️ [1/5] Steam 한국 최고 매출 Top 10 크롤링');

    const data = await fetchJsonWithRetry(
        'https://store.steampowered.com/search/results/?query&start=0&count=10&filter=topsellers&infinite=1&cc=kr&l=koreana',
        {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Cookie: 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
            }
        },
        'Steam 목록'
    );

    if (typeof data?.results_html !== 'string') {
        throw new Error('Steam 응답에 results_html이 없습니다.');
    }

    const $ = cheerio.load(data.results_html);
    const results = [];

    $('.search_result_row').each((index, element) => {
        if (index >= 10) return false;

        const name = $(element).find('.title').text().trim();
        const rawAppId = $(element).attr('data-ds-appid') ?? '';
        const appId = rawAppId.split(',')[0].trim();
        const finalPrice = $(element).find('.discount_final_price').text().trim();
        const originalPrice = $(element).find('.discount_original_price').text().trim();
        const discountText = $(element).find('.discount_pct').text().trim();

        if (!name) return;

        let price = null;
        if (finalPrice) {
            const isFree = finalPrice.includes('무료') || finalPrice.toLowerCase().includes('free');
            price = isFree
                ? { isFree: true, final: '무료', initial: '무료', discountPercent: 0, isDiscounted: false }
                : {
                    isFree: false,
                    final: finalPrice,
                    initial: originalPrice || finalPrice,
                    discountPercent: discountText ? Number.parseInt(discountText.replace(/[-%]/g, ''), 10) || 0 : 0,
                    isDiscounted: Boolean(discountText)
                };
        }

        results.push({ name, appId, price, developer: '알 수 없음', genre: '기타' });
    });

    if (results.length < MIN_EXPECTED_RESULTS) {
        throw new Error(`Steam 결과가 ${results.length}건뿐입니다. 파서 또는 외부 응답을 확인해야 합니다.`);
    }

    await Promise.all(results.map(async (game) => {
        if (!game.appId) return;

        try {
            const details = await fetchJsonWithRetry(
                `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(game.appId)}&cc=kr&l=koreana`,
                {
                    headers: {
                        Cookie: 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1; mature_content=1'
                    }
                },
                `Steam 상세정보 ${game.appId}`,
                2
            );

            const item = details?.[game.appId];
            if (item?.success && item.data) {
                game.developer = Array.isArray(item.data.developers)
                    ? item.data.developers.join(', ')
                    : '알 수 없음';
                game.genre = Array.isArray(item.data.genres) && item.data.genres[0]?.description
                    ? item.data.genres[0].description
                    : '기타';
            }
        } catch (error) {
            console.warn(`⚠️ Steam 상세정보 생략 (${game.appId}): ${safeErrorMessage(error)}`);
        }
    }));

    console.log(`✅ Steam ${results.length}건 수집 완료`);
    return results;
}

async function fetchPlayStoreTop10() {
    console.log('▶️ [2/5] Google Play 한국 게임 최고 매출 Top 10 크롤링');

    const data = await withTimeout(
        gplay.list({
            collection: gplay.collection.GROSSING,
            category: gplay.category.GAME,
            num: 10,
            country: 'kr',
            lang: 'ko'
        }),
        30_000,
        'Google Play 목록'
    );

    if (!Array.isArray(data) || data.length < MIN_EXPECTED_RESULTS) {
        throw new Error(`Google Play 결과가 ${Array.isArray(data) ? data.length : 0}건뿐입니다.`);
    }

    await Promise.all(data.map(async (game) => {
        if (!game.appId) return;

        try {
            const details = await withTimeout(
                gplay.app({ appId: game.appId, lang: 'ko', country: 'kr' }),
                20_000,
                `Google Play 상세정보 ${game.appId}`
            );
            game.genre = details?.genre || game.genre || '기타';
            game.developer = details?.developer || game.developer || '알 수 없음';
        } catch (error) {
            console.warn(`⚠️ Google Play 상세정보 생략 (${game.appId}): ${safeErrorMessage(error)}`);
            game.genre = game.genre || '기타';
            game.developer = game.developer || '알 수 없음';
        }
    }));

    console.log(`✅ Google Play ${data.length}건 수집 완료`);
    return data;
}

function loadCredentials() {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        throw new Error('credentials.json이 없습니다. GCP_CREDENTIALS Secret을 확인해 주세요.');
    }

    let credentials;
    try {
        credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
    } catch (error) {
        throw new Error(`credentials.json JSON 파싱 실패: ${safeErrorMessage(error)}`);
    }

    if (!credentials.client_email || !credentials.private_key) {
        throw new Error('credentials.json에 client_email 또는 private_key가 없습니다.');
    }

    return credentials;
}

async function openSpreadsheet() {
    const credentials = loadCredentials();
    const jwt = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive.file'
        ]
    });

    const doc = new GoogleSpreadsheet(spreadsheetId, jwt);
    await withTimeout(doc.loadInfo(), 30_000, 'Google Sheets 문서 접근');
    console.log(`✅ Google Sheets 인증 성공: ${doc.title}`);
    return doc;
}

async function deleteSheetById(doc, sheetId, fallbackTitle) {
    let lastError;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            await doc.loadInfo();
            const sheet = doc.sheetsById[sheetId] || (fallbackTitle ? doc.sheetsByTitle[fallbackTitle] : null);
            if (!sheet) return;
            await sheet.delete();
            await delay(1_000);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 3) await delay(1_500 * attempt);
        }
    }

    throw new Error(`테스트 탭 삭제 실패 (${fallbackTitle || sheetId}): ${safeErrorMessage(lastError)}`);
}

async function cleanupOrphanTestSheets(doc, keepIds = new Set()) {
    await doc.loadInfo();
    const candidates = [...doc.sheetsByIndex].filter((sheet) =>
        sheet.title.startsWith(TEST_PREFIX) && !keepIds.has(sheet.sheetId)
    );

    for (const sheet of candidates) {
        console.log(`🧹 이전 테스트 잔존 탭 삭제: ${sheet.title}`);
        await deleteSheetById(doc, sheet.sheetId, sheet.title);
    }

    return candidates.length;
}

function writeAndVerifyLocalArtifacts(runToken, steamData, playData) {
    console.log('▶️ [3/5] 로컬 data/history/pending 파일 생성·검증·삭제');

    const workDir = path.join(TEST_WORK_ROOT, runToken);
    const historyDir = path.join(workDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    const dataFile = path.join(workDir, 'data.json');
    const historyFile = path.join(historyDir, `${runToken}.json`);
    const historyListFile = path.join(historyDir, 'history_list.json');
    const pendingFile = path.join(workDir, 'pending_sheets.json');

    const payload = {
        lastUpdated: kstTimestamp(),
        steamGlobal: steamData,
        playKr: playData
    };

    fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(historyFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.writeFileSync(historyListFile, JSON.stringify([runToken], null, 2), 'utf8');
    fs.writeFileSync(pendingFile, JSON.stringify([], null, 2), 'utf8');

    const dataReadback = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const historyReadback = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    const pendingReadback = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));

    if (dataReadback.steamGlobal.length !== steamData.length || dataReadback.playKr.length !== playData.length) {
        throw new Error('data.json 로컬 쓰기/읽기 검증 실패');
    }
    if (historyReadback.steamGlobal.length !== steamData.length || !Array.isArray(pendingReadback)) {
        throw new Error('history 또는 pending 파일 로컬 검증 실패');
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    if (fs.existsSync(workDir)) {
        throw new Error('로컬 테스트 작업 폴더 삭제 실패');
    }

    console.log('✅ 로컬 테스트 파일 생성·검증·삭제 완료');
}

async function runGoogleSheetsRoundTrip(doc, runToken, steamData, playData) {
    console.log('▶️ [4/5] Google Sheets 임시 탭 생성·쓰기·교체·삭제');

    const targetTitle = `${TEST_PREFIX}${runToken}_TARGET`.slice(0, 95);
    const tempTitle = `${TEST_PREFIX}${runToken}_TEMP`.slice(0, 95);
    let oldSheet = null;
    let tempSheet = null;
    const cleanupErrors = [];

    try {
        oldSheet = await doc.addSheet({
            title: targetTitle,
            gridProperties: { rowCount: 20, columnCount: 8 }
        });
        await oldSheet.loadCells('A1:B2');
        oldSheet.getCell(0, 0).value = 'OLD_TEST_SHEET';
        await oldSheet.saveUpdatedCells();

        tempSheet = await doc.addSheet({
            title: tempTitle,
            gridProperties: { rowCount: 20, columnCount: 8 }
        });

        await tempSheet.loadCells('A1:G12');

        const linkCell = tempSheet.getCell(0, 0);
        linkCell.formula = `=HYPERLINK("${DASHBOARD_URL}", "웹 대시보드 열기")`;
        linkCell.textFormat = { bold: true, fontSize: 12 };
        linkCell.backgroundColor = { red: 0.8, green: 0.9, blue: 1.0 };

        const headers = [
            '순위', '스팀(한국) 게임명', '스팀(한국) 개발사', '스팀 가격 / 할인율',
            '순위', '구글(한국) 게임명', '구글(한국) 개발사'
        ];

        headers.forEach((header, column) => {
            const cell = tempSheet.getCell(1, column);
            cell.value = header;
            cell.textFormat = { bold: true };
            cell.backgroundColor = { red: 0.9, green: 0.9, blue: 0.9 };
        });

        for (let index = 0; index < 10; index += 1) {
            const row = index + 2;
            const steam = steamData[index];
            const play = playData[index];

            if (steam) {
                tempSheet.getCell(row, 0).value = index + 1;
                tempSheet.getCell(row, 1).value = steam.name || '';
                tempSheet.getCell(row, 2).value = steam.developer || '';
                if (steam.price) {
                    tempSheet.getCell(row, 3).value = steam.price.isDiscounted
                        ? `${steam.price.final} (-${steam.price.discountPercent}%)`
                        : steam.price.final;
                } else {
                    tempSheet.getCell(row, 3).value = '-';
                }
            }

            if (play) {
                tempSheet.getCell(row, 4).value = index + 1;
                tempSheet.getCell(row, 5).value = play.title || play.name || '';
                tempSheet.getCell(row, 6).value = play.developer || '';
            }
        }

        await withTimeout(tempSheet.saveUpdatedCells(), 30_000, 'Google Sheets 셀 저장');
        await doc.loadInfo();

        const savedSheet = doc.sheetsById[tempSheet.sheetId];
        if (!savedSheet) throw new Error('저장한 테스트 탭을 다시 찾지 못했습니다.');

        await savedSheet.loadCells('A1:G12');
        if (savedSheet.getCell(1, 0).value !== '순위') {
            throw new Error('Google Sheets 헤더 읽기 검증 실패');
        }
        if (!savedSheet.getCell(2, 1).value || !savedSheet.getCell(2, 5).value) {
            throw new Error('Google Sheets 게임 데이터 읽기 검증 실패');
        }

        await deleteSheetById(doc, oldSheet.sheetId, targetTitle);
        oldSheet = null;

        let renamed = false;
        let renameError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await tempSheet.updateProperties({ title: targetTitle });
                renamed = true;
                break;
            } catch (error) {
                renameError = error;
                if (attempt < 3) await delay(2_000 * attempt);
            }
        }
        if (!renamed) {
            throw new Error(`임시 탭 이름 변경 실패: ${safeErrorMessage(renameError)}`);
        }

        await doc.loadInfo();
        const finalSheet = doc.sheetsByTitle[targetTitle];
        if (!finalSheet || finalSheet.sheetId !== tempSheet.sheetId) {
            throw new Error('임시 탭 교체 결과 검증 실패');
        }

        console.log('✅ Google Sheets 생성·쓰기·읽기·삭제·이름변경 검증 완료');
    } finally {
        if (oldSheet) {
            try {
                await deleteSheetById(doc, oldSheet.sheetId, targetTitle);
            } catch (error) {
                cleanupErrors.push(safeErrorMessage(error));
            }
        }

        if (tempSheet) {
            try {
                await deleteSheetById(doc, tempSheet.sheetId, targetTitle);
            } catch (error) {
                try {
                    await deleteSheetById(doc, tempSheet.sheetId, tempTitle);
                } catch (fallbackError) {
                    cleanupErrors.push(safeErrorMessage(fallbackError));
                }
            }
        }

        try {
            await cleanupOrphanTestSheets(doc);
        } catch (error) {
            cleanupErrors.push(safeErrorMessage(error));
        }

        if (cleanupErrors.length > 0) {
            throw new Error(`Google Sheets 롤백 실패: ${cleanupErrors.join(' | ')}`);
        }
    }
}

async function sendPersistentDiscordTestReport(summary) {
    console.log('▶️ [5/5] Discord 테스트 결과 메시지 전송');

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        throw new Error('DISCORD_WEBHOOK_URL Secret이 없습니다.');
    }

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: truncateText([
                '🧪 **[시스템 자가 진단 성공] 전체 왕복 테스트 완료!**',
                summary,
                '',
                'Google Sheets 테스트 탭과 로컬 테스트 파일은 모두 삭제했습니다.',
                '이 Discord 메시지는 테스트 실행 기록으로 유지됩니다.'
            ].join('\n'), DISCORD_MESSAGE_LIMIT)
        }),
        signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
        throw new Error(`Discord 테스트 결과 전송 HTTP ${response.status}`);
    }

    console.log('✅ Discord 테스트 결과 메시지 전송 완료');
}

async function sendPersistentFailureAlert({ startedAt, runToken, failedStage, error, completedStages, cleanupSummary }) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        throw new Error('DISCORD_WEBHOOK_URL Secret이 없어 실패 상세 알림을 보낼 수 없습니다.');
    }

    const runUrl = githubActionsRunUrl();
    const completedText = completedStages.length > 0
        ? completedStages.map((stage) => `• ${stage}`).join('\n')
        : '• 완료된 테스트 구간 없음';

    const content = truncateText([
        '🚨 **[시스템 자가 진단 실패] 왕복 테스트 중 오류 발생!**',
        `시간: \`${startedAt}\``,
        `실패 구간: **${failedStage}**`,
        `오류 내용: \`${truncateText(safeErrorMessage(error), 700)}\``,
        '',
        '**완료된 구간**',
        completedText,
        '',
        `롤백 결과: ${cleanupSummary}`,
        `실행 토큰: \`${runToken}\``,
        runUrl ? `GitHub Actions: ${runUrl}` : null,
        '',
        '운영 data.json/history/pending 및 실제 날짜 탭은 수정하지 않았습니다.'
    ].filter(Boolean).join('\n'), DISCORD_MESSAGE_LIMIT);

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
        throw new Error(`Discord 실패 상세 알림 전송 HTTP ${response.status}`);
    }

    markFailureAlertSent();
    console.log('✅ Discord 실패 상세 알림 전송 완료');
}

async function runDiscordRoundTrip(summary) {
    await sendPersistentDiscordTestReport(summary);
}

async function runSystemTest() {
    const runToken = `${Date.now()}_${process.env.GITHUB_RUN_ID || 'local'}_${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = kstTimestamp();
    const results = [];
    const completedStages = [];
    let doc = null;
    let steamData = [];
    let playData = [];
    let failedStage = '초기화';
    let primaryError = null;
    const cleanupErrors = [];

    const runStage = async (label, work) => {
        failedStage = label;
        try {
            const value = await work();
            completedStages.push(`✅ ${label}`);
            return value;
        } catch (error) {
            throw new Error(`[${label}] ${safeErrorMessage(error)}`, { cause: error });
        }
    };

    console.log('============================================================');
    console.log('🧪 GameRankingDashboard 전체 왕복 테스트 시작');
    console.log(`실행 토큰: ${runToken}`);
    console.log(`시작 시각(KST): ${startedAt}`);
    console.log('운영 data.json/history/pending 및 실제 날짜 탭은 수정하지 않습니다.');
    console.log('============================================================');

    try {
        steamData = await runStage('1/5 Steam 한국 최고 매출 Top 10 크롤링', fetchSteamTop10);
        results.push(`✅ Steam 크롤링: ${steamData.length}건`);

        playData = await runStage('2/5 Google Play 한국 게임 최고 매출 Top 10 크롤링', fetchPlayStoreTop10);
        results.push(`✅ Google Play 크롤링: ${playData.length}건`);

        await runStage('3/5 로컬 data/history/pending 생성·읽기·삭제', async () => {
            writeAndVerifyLocalArtifacts(runToken, steamData, playData);
        });
        results.push('✅ 로컬 data/history/pending 생성·읽기·삭제');

        await runStage('4/5 Google Sheets 인증 및 테스트 탭 왕복 처리', async () => {
            doc = await openSpreadsheet();
            const removedOrphans = await cleanupOrphanTestSheets(doc);
            if (removedOrphans > 0) {
                results.push(`✅ 이전 중단 테스트 잔존 탭 ${removedOrphans}개 정리`);
            }
            await runGoogleSheetsRoundTrip(doc, runToken, steamData, playData);
        });
        results.push('✅ Google Sheets 생성·쓰기·읽기·교체·삭제');

        await runStage('5/5 Discord 테스트 결과 메시지 전송', async () => {
            await runDiscordRoundTrip([
                `시간: \`${startedAt}\``,
                ...results,
                '✅ 최종 롤백: 테스트 탭 및 로컬 파일 잔존 없음'
            ].join('\n'));
        });
        results.push('✅ Discord 테스트 결과 메시지 전송');
    } catch (error) {
        primaryError = error;
        results.push(`❌ 실패 구간: ${failedStage}`);
        results.push(`❌ 오류 내용: ${safeErrorMessage(error)}`);
    } finally {
        try {
            if (doc) await cleanupOrphanTestSheets(doc);
        } catch (error) {
            cleanupErrors.push(`Google Sheets 최종 정리 실패: ${safeErrorMessage(error)}`);
        }

        try {
            fs.rmSync(TEST_WORK_ROOT, { recursive: true, force: true });
            if (fs.existsSync(TEST_WORK_ROOT)) {
                cleanupErrors.push('로컬 테스트 작업 폴더가 삭제 후에도 남아 있습니다.');
            }
        } catch (error) {
            cleanupErrors.push(`로컬 작업 폴더 정리 실패: ${safeErrorMessage(error)}`);
        }
    }

    const cleanupSummary = cleanupErrors.length === 0
        ? '✅ 테스트 탭 및 로컬 파일 정리 완료'
        : `❌ ${cleanupErrors.join(' | ')}`;

    if (cleanupErrors.length > 0) {
        results.push(`❌ 롤백 실패: ${cleanupErrors.join(' | ')}`);
        if (!primaryError) {
            failedStage = '최종 롤백 및 잔존물 검증';
            primaryError = new Error(cleanupErrors.join(' | '));
        }
    } else {
        results.push('✅ 최종 롤백: 테스트 탭 및 로컬 파일 잔존 없음');
    }

    if (primaryError) {
        try {
            await sendPersistentFailureAlert({
                startedAt,
                runToken,
                failedStage,
                error: primaryError,
                completedStages,
                cleanupSummary
            });
            results.push('✅ Discord 실패 상세 알림 전송');
        } catch (alertError) {
            results.push(`❌ Discord 실패 상세 알림 전송 실패: ${safeErrorMessage(alertError)}`);
            console.error(`❌ Discord 실패 상세 알림 전송 실패: ${safeErrorMessage(alertError)}`);
        }
    }

    console.log('\n====================== 최종 결과 ======================');
    console.log(results.join('\n'));
    console.log('=======================================================');

    if (primaryError) {
        throw primaryError;
    }
}

runSystemTest().catch((error) => {
    console.error(`\n❌ 시스템 왕복 테스트 최종 실패: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
});
