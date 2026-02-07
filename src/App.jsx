import { useState, useRef, useMemo, useCallback } from "react";

// ═══════════════════════════════════════════════════
//  식품안전정보원 여비정산 시스템 v5
//  — 영수증 일괄 첨부 → AI 자동 출장 생성
// ═══════════════════════════════════════════════════

// ── 상수 ──
const MEAL_ALLOWANCE = 25000;
const MEAL_DEDUCTION = 8333;
const DAILY_ALLOWANCE = 25000;
const DAILY_ALLOWANCE_HALF = 12500;
const FUEL_RATE = 1680; // 원/km

// 직원 숙박비 상한
const LODGING_LIMITS_STAFF = { 서울: 100000, 광역시: 80000, 기타: 70000 };

// 관내출장 정액
const DOMESTIC_SHORT = 10000;
const DOMESTIC_LONG = 20000;

// 광역지자체 매핑 DB
const METRO_MAP = {
  서울: ["서울", "서울특별시", "서울시"],
  부산: ["부산", "부산광역시", "부산시"],
  대구: ["대구", "대구광역시", "대구시"],
  인천: ["인천", "인천광역시", "인천시"],
  광주: ["광주", "광주광역시", "광주시"],
  대전: ["대전", "대전광역시", "대전시"],
  울산: ["울산", "울산광역시", "울산시"],
  세종: ["세종", "세종특별자치시", "세종시", "정부세종청사", "세종정부청사"],
  경기: ["경기", "경기도", "수원", "성남", "용인", "안양", "안산", "고양", "과천", "광명", "구리", "군포", "김포", "남양주", "동두천", "부천", "시흥", "안성", "양주", "양평", "여주", "오산", "의왕", "의정부", "이천", "파주", "평택", "포천", "하남", "화성"],
  강원: ["강원", "강원특별자치도", "강원도", "춘천", "원주", "강릉", "속초", "동해", "태백", "삼척"],
  충북: ["충북", "충청북도", "청주", "충주", "제천", "괴산", "단양", "보은", "영동", "옥천", "음성", "진천", "증평"],
  충남: ["충남", "충청남도", "천안", "아산", "논산", "공주", "서산", "당진", "보령", "홍성", "예산", "태안", "부여"],
  전북: ["전북", "전북특별자치도", "전라북도", "전주", "익산", "군산", "정읍", "김제", "남원", "완주"],
  전남: ["전남", "전라남도", "목포", "여수", "순천", "나주", "광양", "무안", "해남", "담양"],
  경북: ["경북", "경상북도", "포항", "경주", "구미", "안동", "김천", "영주", "영천", "상주", "문경", "칠곡"],
  경남: ["경남", "경상남도", "창원", "김해", "진주", "양산", "거제", "통영", "사천", "밀양", "함안", "거창"],
  제주: ["제주", "제주특별자치도", "제주도", "제주시", "서귀포"],
};

const METRO_CITIES = ["부산", "대구", "인천", "광주", "대전", "울산"];

const TRANSPORT_TYPES = [
  { value: "rail", label: "철도", icon: "🚄" },
  { value: "personal_car", label: "자가차량", icon: "🚗" },
  { value: "official_car", label: "공용차량", icon: "🚐" },
  { value: "public_transit", label: "대중교통", icon: "🚌" },
];

// ── 유틸리티 ──
const uid = () => Math.random().toString(36).slice(2, 9);

const detectMetro = (text) => {
  if (!text) return null;
  const t = text.trim();
  for (const [metro, keywords] of Object.entries(METRO_MAP)) {
    for (const kw of keywords) {
      if (t.includes(kw)) return metro;
    }
  }
  return null;
};

const getLodgingRegion = (metro) => {
  if (!metro) return "기타";
  if (metro === "서울") return "서울";
  if (METRO_CITIES.includes(metro)) return "광역시";
  return "기타";
};

const amountToKorean = (n) => {
  if (!n || n === 0) return "영";
  const units = ["", "만", "억"];
  const nums = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
  const divs = [1, 10000, 100000000];
  let result = "";
  for (let i = units.length - 1; i >= 0; i--) {
    const d = Math.floor(n / divs[i]);
    if (d > 0) {
      const thousands = Math.floor(d / 1000);
      const hundreds = Math.floor((d % 1000) / 100);
      const tens = Math.floor((d % 100) / 10);
      const ones = d % 10;
      let part = "";
      if (thousands) part += nums[thousands] + "천";
      if (hundreds) part += nums[hundreds] + "백";
      if (tens) part += nums[tens] + "십";
      if (ones) part += nums[ones];
      result += part + units[i];
      n %= divs[i];
    }
  }
  return result || "영";
};

const legFare = (leg) => {
  if (leg.transport === "personal_car") return Math.round((leg.km || 0) * FUEL_RATE) + (leg.tollFee || 0);
  if (leg.transport === "official_car") return (leg.fuelFee || 0) + (leg.tollFee || 0);
  if (leg.transport === "rail") return leg.amount || 0;
  return 0;
};

// ── 빈 데이터 템플릿 ──
const emptyLeg = () => ({
  id: uid(), from: "식품안전정보원", to: "", transport: "rail",
  amount: 0, km: 0, tollFee: 0, fuelFee: 0, trainNo: "",
});

const emptyTrip = () => ({
  id: uid(), date: "", tripType: "outside", destination: "", destinationMetro: null,
  legs: [emptyLeg()],
  breakfast: false, lunch: true, dinner: false, noMeal: false,
  officeCar: false,
  lodgingRegion: "기타", lodgingAmount: 0, noLodging: true,
  farePayMethod: "corp_card", lodgingPayMethod: "corp_card",
  attachments: [],
  proofVerified: false,
  autoGenerated: false, // v5: 자동 생성 여부
});

// ── Claude Vision API 호출 ──
// 이미지 압축 (Vercel 4.5MB 제한 대응)
const compressImage = (file, maxWidth = 1280, quality = 0.8) => new Promise((resolve) => {
  // PDF는 압축 불가 → 그대로 반환
  if (file.type === "application/pdf") {
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mediaType: file.type });
    reader.readAsDataURL(file);
    return;
  }
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
  };
  img.onerror = () => {
    // 압축 실패 시 원본 그대로
    const reader = new FileReader();
    reader.onload = () => resolve({ base64: reader.result.split(",")[1], mediaType: file.type || "image/jpeg" });
    reader.readAsDataURL(file);
  };
  const reader = new FileReader();
  reader.onload = () => { img.src = reader.result; };
  reader.readAsDataURL(file);
});

const analyzeWithClaude = async (file) => {
  try {
    const { base64, mediaType } = await compressImage(file);
    console.log(`📎 ${file.name}: 압축 후 ${Math.round(base64.length / 1024)}KB`);
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mediaType, fileName: file.name }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("Claude API 호출 실패:", res.status, errBody);
      throw new Error(`API 오류: ${res.status} - ${errBody.slice(0, 200)}`);
    }
    const result = await res.json();
    result.simulated = false;
    return result;
  } catch (err) {
    console.error("⚠️ Claude API 실패, 시뮬레이터 대체:", err.message);
    alert(`Claude API 호출 실패: ${err.message}\n\n파일명 기반 시뮬레이션으로 대체됩니다.`);
    return simulateFallback(file);
  }
};

// ── 폴백 시뮬레이터 ──
const simulateFallback = (file) => {
  const name = file.name.toLowerCase();
  // 파일명에서 날짜 추출 시도 (YYYYMMDD 또는 YYYY-MM-DD)
  const dateMatch = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  const extractedDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "";

  if (name.includes("ktx") || name.includes("코레일") || name.includes("열차") || name.includes("승차권") || name.includes("rail")) {
    const isReturn = name.includes("복귀") || name.includes("return") || name.includes("귀환");
    return {
      type: "rail_receipt", category: "철도영수증",
      data: { date: extractedDate, from: isReturn ? "오송" : "서울", to: isReturn ? "서울" : "오송", trainNo: "KTX 301", seatClass: "일반실", amount: 23700 },
      proofMetro: isReturn ? null : "세종", isProof: true, simulated: true
    };
  } else if (name.includes("숙박") || name.includes("호텔") || name.includes("모텔") || name.includes("hotel") || name.includes("lodging")) {
    return {
      type: "lodging_receipt", category: "숙박영수증",
      data: { hotelName: "세종호텔", date: extractedDate, amount: 85000, address: "세종특별자치시 어진동 123" },
      proofMetro: "세종", isProof: true, simulated: true
    };
  } else if (name.includes("톨") || name.includes("toll") || name.includes("하이패스") || name.includes("고속도로")) {
    return {
      type: "toll_receipt", category: "톨게이트영수증",
      data: { tollGate: "서세종IC", amount: 4800, date: extractedDate },
      proofMetro: null, isProof: true, simulated: true
    };
  } else if (name.includes("편의점") || name.includes("식당") || name.includes("카페") || name.includes("마트") || name.includes("영수증")) {
    return {
      type: "local_receipt", category: "현지영수증",
      data: { storeName: "GS25 세종어진점", amount: 3500, date: extractedDate, address: "세종특별자치시 어진동 456" },
      proofMetro: "세종", isProof: true, simulated: true
    };
  } else if (name.includes("지도") || name.includes("map") || name.includes("네이버")) {
    return {
      type: "map_capture", category: "지도캡처",
      data: { from: "서울", to: "세종", distanceKm: 148, estimatedMinutes: 110 },
      proofMetro: null, isProof: false, simulated: true
    };
  }
  return { type: "unknown", category: "기타첨부", data: {}, proofMetro: null, isProof: false, simulated: true };
};

// ═══════════════════════════════════════════════════
//  v5 핵심: 영수증 일괄 분석 → 출장 자동 그룹핑
// ═══════════════════════════════════════════════════
const groupReceiptsIntoTrips = (results) => {
  // 1단계: 날짜별 + 목적지별 그룹핑
  const groups = {};

  results.forEach((r) => {
    const date = r.data?.date || "날짜미확인";
    // 목적지 추론: 철도의 to, 숙박/현지영수증의 proofMetro
    let destination = "";
    if (r.type === "rail_receipt" && r.data?.to) {
      destination = r.data.to;
    } else if (r.proofMetro) {
      destination = r.proofMetro;
    }

    // 그룹 키: 날짜 + 목적지(광역지자체)
    const metro = detectMetro(destination) || destination || "미확인";
    const groupKey = `${date}__${metro}`;

    if (!groups[groupKey]) {
      groups[groupKey] = { date, metro, destination, receipts: [] };
    }
    groups[groupKey].receipts.push(r);
  });

  // 2단계: 각 그룹을 출장으로 변환
  const newTrips = [];

  Object.values(groups).forEach((group) => {
    const trip = emptyTrip();
    trip.autoGenerated = true;
    trip.date = group.date !== "날짜미확인" ? group.date : "";
    trip.destination = group.destination || "";
    trip.destinationMetro = detectMetro(group.destination);

    // v5 설계: 일비/식비 "해당없음" 기본값
    trip.noMeal = true;
    trip.breakfast = false;
    trip.lunch = false;
    trip.dinner = false;
    trip.noLodging = true;

    // 구간(legs) 초기화
    trip.legs = [];

    // 영수증별 처리
    group.receipts.forEach((r) => {
      // 첨부파일 추가
      const att = {
        fileName: r.fileName || "영수증",
        category: r.category,
        type: r.type,
        proofMetro: r.proofMetro,
        isProof: r.isProof,
        simulated: r.simulated || false,
      };
      trip.attachments.push(att);

      // 철도 영수증 → 구간 자동 추가
      if (r.type === "rail_receipt" && r.data) {
        const d = r.data;
        trip.legs.push({
          ...emptyLeg(),
          from: d.from || "식품안전정보원",
          to: d.to || "",
          transport: "rail",
          trainNo: d.trainNo || "",
          amount: d.amount || 0,
        });
      }

      // 숙박 영수증 → 숙박비 자동 입력 (정확한 날짜만 매칭)
      if (r.type === "lodging_receipt" && r.data) {
        const d = r.data;
        const receiptDate = d.date || "";
        // v5 설계: 정확히 같은 날짜만 매칭
        if (!receiptDate || receiptDate === group.date) {
          trip.lodgingAmount = d.amount || 0;
          trip.noLodging = false;
          if (d.address) {
            const metro = detectMetro(d.address);
            if (metro) trip.lodgingRegion = getLodgingRegion(metro);
          }
        }
      }

      // 톨게이트 영수증
      if (r.type === "toll_receipt" && r.data) {
        const existingCarLeg = trip.legs.find((l) =>
          l.transport === "personal_car" || l.transport === "official_car"
        );
        if (existingCarLeg) {
          existingCarLeg.tollFee = (existingCarLeg.tollFee || 0) + (r.data.amount || 0);
        }
      }
    });

    // 구간이 없으면 기본 빈 구간 추가
    if (trip.legs.length === 0) {
      const leg = emptyLeg();
      leg.to = group.destination || "";
      trip.legs = [leg];
    }

    newTrips.push(trip);
  });

  // 날짜순 정렬
  newTrips.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  return newTrips;
};

// ═══════════════ 일괄 업로드 모달 ═══════════════
const BulkUploadModal = ({ isOpen, onClose, onComplete, analyzing }) => {
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [step, setStep] = useState("select"); // select → analyzing → preview → done
  const [progress, setProgress] = useState(0);
  const fileRef = useRef(null);

  const handleFiles = (e) => {
    const newFiles = Array.from(e.target.files);
    setFiles((prev) => [...prev, ...newFiles]);
    e.target.value = "";
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const startAnalysis = async () => {
    if (files.length === 0) return;
    setStep("analyzing");
    setProgress(0);
    const allResults = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const result = await analyzeWithClaude(file);
        result.fileName = file.name;
        allResults.push(result);
      } catch (err) {
        console.error(`분석 실패: ${file.name}`, err);
        allResults.push({
          type: "unknown", category: "분석실패", data: {},
          proofMetro: null, isProof: false, fileName: file.name, error: true
        });
      }
      setProgress(Math.round(((i + 1) / files.length) * 100));
    }

    setResults(allResults);
    setStep("preview");
  };

  const confirmAndCreate = () => {
    const trips = groupReceiptsIntoTrips(results);
    onComplete(trips);
    // 초기화
    setFiles([]);
    setResults([]);
    setStep("select");
    setProgress(0);
    onClose();
  };

  const handleClose = () => {
    setFiles([]);
    setResults([]);
    setStep("select");
    setProgress(0);
    onClose();
  };

  if (!isOpen) return null;

  // 미리보기용 그룹핑
  const previewTrips = step === "preview" ? groupReceiptsIntoTrips(results) : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col">
        {/* 모달 헤더 */}
        <div className="bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-3 flex items-center justify-between">
          <div>
            <h3 className="text-white font-bold text-sm">🤖 영수증 일괄 분석</h3>
            <p className="text-violet-200 text-xs mt-0.5">영수증을 한번에 올리면 출장이 자동으로 생성됩니다</p>
          </div>
          <button onClick={handleClose} className="text-white/70 hover:text-white text-lg">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* STEP 1: 파일 선택 */}
          {step === "select" && (
            <div className="space-y-4">
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-violet-300 rounded-xl p-8 text-center cursor-pointer hover:border-violet-500 hover:bg-violet-50 transition-all"
              >
                <div className="text-3xl mb-2">📎</div>
                <p className="text-sm font-medium text-gray-700">영수증 파일을 선택하세요</p>
                <p className="text-xs text-gray-500 mt-1">PDF, PNG, JPG · 여러 파일 동시 선택 가능</p>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" multiple className="hidden" onChange={handleFiles} />
              </div>

              {files.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-gray-600 mb-2">선택된 파일 ({files.length}개)</p>
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 text-xs">
                      <span className="text-gray-400">📄</span>
                      <span className="flex-1 truncate font-medium">{f.name}</span>
                      <span className="text-gray-400">{(f.size / 1024).toFixed(0)}KB</span>
                      <button onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500">✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* STEP 2: 분석 중 */}
          {step === "analyzing" && (
            <div className="text-center py-8">
              <div className="text-4xl mb-4 animate-pulse">🔍</div>
              <p className="text-sm font-medium text-gray-700 mb-2">AI가 영수증을 분석하고 있습니다...</p>
              <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
                <div className="bg-violet-600 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
              </div>
              <p className="text-xs text-gray-500">{progress}% ({Math.round(progress / 100 * files.length)}/{files.length})</p>
            </div>
          )}

          {/* STEP 3: 미리보기 */}
          {step === "preview" && (
            <div className="space-y-4">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-emerald-700">
                  ✅ {results.length}개 영수증 분석 완료 → {previewTrips.length}건의 출장이 생성됩니다
                </p>
                <p className="text-xs text-emerald-600 mt-0.5">일비·식비는 "해당없음"으로 설정됩니다. 생성 후 직접 수정해 주세요.</p>
              </div>

              {previewTrips.map((trip, i) => (
                <div key={i} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-100 px-3 py-2 flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-700">출장 #{i + 1}</span>
                    {trip.date && <span className="text-xs text-gray-500">{trip.date}</span>}
                    {trip.destinationMetro && (
                      <span className="text-xs px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded-full">{trip.destinationMetro}</span>
                    )}
                    <span className="text-xs px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded-full ml-auto">자동생성</span>
                  </div>
                  <div className="px-3 py-2 space-y-1">
                    {trip.legs.map((leg, j) => (
                      <div key={j} className="text-xs text-gray-600 flex items-center gap-1">
                        <span>🚄</span>
                        <span>{leg.from} → {leg.to}</span>
                        {leg.trainNo && <span className="text-gray-400">({leg.trainNo})</span>}
                        {leg.amount > 0 && <span className="font-mono text-blue-600 ml-auto">{leg.amount.toLocaleString()}원</span>}
                      </div>
                    ))}
                    {!trip.noLodging && trip.lodgingAmount > 0 && (
                      <div className="text-xs text-gray-600 flex items-center gap-1">
                        <span>🏨</span>
                        <span>숙박비</span>
                        <span className="font-mono text-blue-600 ml-auto">{trip.lodgingAmount.toLocaleString()}원</span>
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-1">
                      📎 {trip.attachments.length}개 증빙 첨부
                    </div>
                  </div>
                </div>
              ))}

              {results.some((r) => r.error) && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-700 font-medium">⚠️ 분석 실패 항목:</p>
                  {results.filter((r) => r.error).map((r, i) => (
                    <p key={i} className="text-xs text-amber-600">{r.fileName}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 모달 푸터 */}
        <div className="border-t border-gray-200 px-5 py-3 flex gap-2">
          {step === "select" && (
            <>
              <button onClick={handleClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
              <button
                onClick={startAnalysis}
                disabled={files.length === 0}
                className="flex-1 py-2.5 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all"
              >
                🔍 {files.length}개 분석 시작
              </button>
            </>
          )}
          {step === "preview" && (
            <>
              <button onClick={handleClose} className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">취소</button>
              <button
                onClick={confirmAndCreate}
                className="flex-1 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 transition-all"
              >
                ✅ {previewTrips.length}건 출장 생성
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};


// ═══════════════ 구간 카드 ═══════════════
const LegCard = ({ leg, index, total, onUpdate, onRemove, canRemove, isExecutive }) => {
  const u = (k, v) => onUpdate(leg.id, k, v);
  const colors = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];
  const color = colors[index % colors.length];

  return (
    <div className="border-l-4 rounded-r-lg bg-white p-3 mb-2" style={{ borderColor: color }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold" style={{ color }}>구간 {index + 1}/{total}</span>
        {canRemove && <button onClick={() => onRemove(leg.id)} className="text-xs text-red-400 hover:text-red-600">✕ 삭제</button>}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <input value={leg.from} onChange={(e) => u("from", e.target.value)} placeholder="출발지" className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white" />
        <input value={leg.to} onChange={(e) => u("to", e.target.value)} placeholder="도착지" className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white" />
      </div>
      <div className="flex gap-1 mb-2 flex-wrap">
        {TRANSPORT_TYPES.map((t) => (
          <button key={t.value} onClick={() => u("transport", t.value)}
            className={`px-2 py-1 rounded text-xs border transition-all ${leg.transport === t.value ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {leg.transport === "rail" && (
        <div className="grid grid-cols-2 gap-2">
          <input value={leg.trainNo} onChange={(e) => u("trainNo", e.target.value)} placeholder="열차번호 (예: KTX 301)" className="px-2 py-1.5 border border-gray-300 rounded text-xs" />
          <input type="number" value={leg.amount || ""} onChange={(e) => u("amount", Number(e.target.value))} placeholder="운임 (원)" className="px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
          {isExecutive && (
            <div className="col-span-2 text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">👔 임원: KTX 특실 이용 가능</div>
          )}
        </div>
      )}

      {leg.transport === "personal_car" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">편도 거리(km)</label>
              <input type="number" value={leg.km || ""} onChange={(e) => u("km", Number(e.target.value))} placeholder="km" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">유류비 (자동계산)</label>
              <div className="px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-xs font-mono text-blue-700 font-bold">
                {((leg.km || 0) * FUEL_RATE).toLocaleString()}원
              </div>
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-0.5 block">톨게이트비 (원)</label>
            <input type="number" value={leg.tollFee || ""} onChange={(e) => u("tollFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
          </div>
          <div className="text-xs text-gray-400">유류비 단가: {FUEL_RATE.toLocaleString()}원/km</div>
        </div>
      )}

      {leg.transport === "official_car" && (
        <div className="space-y-2">
          <div className="text-xs text-sky-600 bg-sky-50 px-2 py-1 rounded">🚐 공용차량: 일비 50% 감액 적용</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">유류비 (해당 시)</label>
              <input type="number" value={leg.fuelFee || ""} onChange={(e) => u("fuelFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-0.5 block">톨게이트비 (해당 시)</label>
              <input type="number" value={leg.tollFee || ""} onChange={(e) => u("tollFee", Number(e.target.value))} placeholder="0" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono" />
            </div>
          </div>
        </div>
      )}

      {leg.transport === "public_transit" && (
        <div className="text-xs text-gray-500 bg-gray-50 px-2 py-1.5 rounded">
          🚌 대중교통 운임은 일비에 포함 (별도 정산 없음)
        </div>
      )}
    </div>
  );
};

// ═══════════════ 출장 카드 ═══════════════
const TripCard = ({ trip, index, onUpdate, onRemove, canRemove, isExecutive, analyzing, onAnalyzeFile }) => {
  const fileRef = useRef(null);
  const u = useCallback((k, v) => onUpdate(trip.id, k, v), [trip.id, onUpdate]);

  const updateLeg = useCallback((legId, key, val) => {
    const newLegs = trip.legs.map((l) => l.id === legId ? { ...l, [key]: val } : l);
    if (key === "to") {
      const idx = newLegs.findIndex((l) => l.id === legId);
      if (idx >= 0 && idx < newLegs.length - 1) newLegs[idx + 1] = { ...newLegs[idx + 1], from: val };
    }
    u("legs", newLegs);
  }, [trip.legs, u]);

  const addLeg = () => {
    const lastLeg = trip.legs[trip.legs.length - 1];
    const nl = emptyLeg();
    nl.from = lastLeg?.to || "";
    u("legs", [...trip.legs, nl]);
  };

  const removeLeg = (legId) => {
    if (trip.legs.length <= 1) return;
    u("legs", trip.legs.filter((l) => l.id !== legId));
  };

  const hasOfficialCar = trip.legs.some((l) => l.transport === "official_car");
  const totalFare = trip.legs.reduce((s, l) => s + legFare(l), 0);

  const handleDestChange = (val) => {
    u("destination", val);
    u("destinationMetro", detectMetro(val));
    if (trip.legs.length > 0) {
      const firstLeg = trip.legs[0];
      const newLegs = [...trip.legs];
      newLegs[0] = { ...firstLeg, from: firstLeg.from || "식품안전정보원", to: val };
      u("legs", newLegs);
    }
  };

  // 관외증빙 상태 계산
  const hasTransportProof = trip.attachments.some((a) => a.type === "rail_receipt" || a.type === "toll_receipt");
  const hasLocalProof = trip.attachments.some((a) =>
    a.type === "local_receipt" && a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro
  );
  const hasLodgingProof = trip.attachments.some((a) =>
    a.type === "lodging_receipt" && a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro
  );
  const proofOk = trip.tripType !== "outside" || hasTransportProof || hasLocalProof || hasLodgingProof;

  const isDomestic = trip.tripType !== "outside";

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* 헤더 */}
      <div className={`px-4 py-2.5 flex items-center justify-between ${trip.autoGenerated ? "bg-gradient-to-r from-violet-600 to-indigo-600" : "bg-gradient-to-r from-slate-700 to-slate-600"}`}>
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-bold">출장 #{index + 1}</span>
          {trip.autoGenerated && (
            <span className="text-xs px-1.5 py-0.5 bg-white/20 text-white rounded-full">🤖 자동생성</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {trip.tripType === "outside" && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${proofOk ? "bg-emerald-400/20 text-emerald-200" : "bg-red-400/20 text-red-200"}`}>
              {proofOk ? "✅ 증빙확인" : "⚠️ 증빙필요"}
            </span>
          )}
          {canRemove && <button onClick={() => onRemove(trip.id)} className="text-white/60 hover:text-white text-sm">✕</button>}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* 자동생성 안내 (noMeal 상태일 때) */}
        {trip.autoGenerated && trip.noMeal && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
            <p className="text-xs font-semibold text-violet-700">
              🤖 자동으로 생성된 출장입니다
            </p>
            <p className="text-xs text-violet-600 mt-0.5">
              일비·식비는 "해당없음"으로 설정되었습니다. 필요시 수정해 주세요.
            </p>
          </div>
        )}

        {/* 기본정보 */}
        <div className="grid grid-cols-2 gap-2">
          <input type="date" value={trip.date} onChange={(e) => u("date", e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded text-xs" />
          <select value={trip.tripType} onChange={(e) => u("tripType", e.target.value)} className="px-2 py-1.5 border border-gray-300 rounded text-xs bg-white">
            <option value="outside">관외출장</option>
            <option value="domestic_long">관내(4h이상)</option>
            <option value="domestic_short">관내(4h미만)</option>
          </select>
        </div>

        {/* 출장지 */}
        <div>
          <div className="flex items-center gap-2">
            <input value={trip.destination} onChange={(e) => handleDestChange(e.target.value)} placeholder="출장지 (예: 세종정부청사, 부산 BEXCO)" className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs" />
            {trip.destinationMetro && (
              <span className="text-xs px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full font-medium whitespace-nowrap">
                📍 {trip.destinationMetro}
              </span>
            )}
          </div>
        </div>

        {/* 관내: 정액 안내 */}
        {isDomestic && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
            <span className="text-sm font-bold text-amber-700">
              정액 {trip.tripType === "domestic_short" ? "10,000" : "20,000"}원
            </span>
            <p className="text-xs text-amber-600 mt-1">관내출장은 정액 지급 (세부 항목 없음)</p>
          </div>
        )}

        {/* 관외: 상세 입력 */}
        {!isDomestic && (
          <>
            {/* 구간(Leg) 목록 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">이동 구간</span>
                <button onClick={addLeg} className="text-xs text-blue-600 hover:text-blue-800 font-medium">+ 경유 구간 추가</button>
              </div>
              {trip.legs.map((leg, i) => (
                <LegCard key={leg.id} leg={leg} index={i} total={trip.legs.length}
                  onUpdate={updateLeg} onRemove={removeLeg} canRemove={trip.legs.length > 1} isExecutive={isExecutive} />
              ))}
            </div>

            {/* 운임 소계 + 결제수단 */}
            {totalFare > 0 && (
              <div className="bg-blue-50 rounded-lg px-3 py-2">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs text-gray-600">운임 소계</span>
                  <span className="text-sm font-bold text-blue-700">{totalFare.toLocaleString()}원</span>
                </div>
                <div className="flex gap-2">
                  {["corp_card", "personal"].map((m) => (
                    <button key={m} onClick={() => u("farePayMethod", m)}
                      className={`flex-1 py-1.5 rounded text-center text-xs border transition-all ${trip.farePayMethod === m ? (m === "corp_card" ? "bg-blue-600 text-white border-blue-600" : "bg-emerald-600 text-white border-emerald-600") : "border-gray-300 bg-white"}`}>
                      {m === "corp_card" ? "💳 법인카드" : "🏦 개인부담"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 일비/식비 */}
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">일비: {(hasOfficialCar ? DAILY_ALLOWANCE_HALF : DAILY_ALLOWANCE).toLocaleString()}원</span>
                {hasOfficialCar && <span className="text-xs text-sky-600">공용차량 50% 감액</span>}
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">식비</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={trip.noMeal} onChange={(e) => u("noMeal", e.target.checked)} className="w-3.5 h-3.5 rounded" />
                  <span className="text-xs text-red-500 font-medium">해당없음</span>
                </label>
              </div>
              {!trip.noMeal && (
                <div className="flex gap-2">
                  {[["breakfast", "조식"], ["lunch", "중식"], ["dinner", "석식"]].map(([key, label]) => (
                    <label key={key} className={`flex-1 py-1.5 rounded text-center cursor-pointer border text-xs transition-all ${trip[key] ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"}`}>
                      <input type="checkbox" className="hidden" checked={trip[key]} onChange={(e) => u(key, e.target.checked)} />{label} 제공
                    </label>
                  ))}
                </div>
              )}
              {!trip.noMeal && (
                <div className="text-xs text-gray-400 mt-1.5">
                  제공된 식사 1끼당 {MEAL_DEDUCTION.toLocaleString()}원 감액
                </div>
              )}
            </div>

            {/* 숙박비 */}
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">숙박비</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={trip.noLodging} onChange={(e) => u("noLodging", e.target.checked)} className="w-3.5 h-3.5 rounded" />
                  <span className="text-xs text-red-500 font-medium">해당없음 (당일출장)</span>
                </label>
              </div>
              {!trip.noLodging && (
                <>
                  <div className="flex gap-1.5 mb-1.5">
                    {(isExecutive
                      ? [["실비", "실비"]]
                      : Object.entries(LODGING_LIMITS_STAFF).map(([r, l]) => [r, `${r}(${(l / 10000)}만)`])
                    ).map(([val, label]) => (
                      <button key={val} onClick={() => u("lodgingRegion", val)}
                        className={`flex-1 py-1 rounded text-xs border ${trip.lodgingRegion === val ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200"}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {isExecutive && (
                    <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded mb-1.5">👔 임원: 숙박비 상한 없음 (실비 정산)</div>
                  )}
                  <input type="number" value={trip.lodgingAmount || ""} onChange={(e) => u("lodgingAmount", Number(e.target.value))} placeholder="숙박비 (원)" className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono bg-white" />
                  {!isExecutive && trip.lodgingAmount > (LODGING_LIMITS_STAFF[trip.lodgingRegion] || 70000) && (
                    <p className="text-xs text-red-600 mt-1">⚠️ 상한 {(LODGING_LIMITS_STAFF[trip.lodgingRegion] || 70000).toLocaleString()}원 초과</p>
                  )}
                  {trip.lodgingAmount > 0 && (
                    <div className="flex gap-2 mt-1.5">
                      {["corp_card", "personal"].map((m) => (
                        <button key={m} onClick={() => u("lodgingPayMethod", m)}
                          className={`flex-1 py-1 rounded text-center text-xs border ${trip.lodgingPayMethod === m ? (m === "corp_card" ? "bg-blue-600 text-white border-blue-600" : "bg-emerald-600 text-white border-emerald-600") : "border-gray-300 bg-white"}`}>
                          {m === "corp_card" ? "💳 법인카드" : "🏦 개인부담"}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 첨부파일 + Claude Vision */}
            <div className="border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">📎 증빙서류 첨부</span>
                <button onClick={() => fileRef.current?.click()} disabled={analyzing}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:text-gray-400">
                  {analyzing ? "⏳ 분석 중..." : "+ Claude AI 분석"}
                </button>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden"
                  onChange={(e) => { if (e.target.files[0]) onAnalyzeFile(trip.id, e.target.files[0]); e.target.value = ""; }} />
              </div>

              {trip.attachments.length > 0 && (
                <div className="space-y-1">
                  {trip.attachments.map((a, i) => {
                    const metroMatch = a.proofMetro && trip.destinationMetro && a.proofMetro === trip.destinationMetro;
                    return (
                      <div key={i} className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${metroMatch ? "bg-emerald-50 border border-emerald-200" : a.isProof ? "bg-blue-50 border border-blue-200" : "bg-gray-50 border border-gray-200"}`}>
                        <span>{a.type === "rail_receipt" ? "🚄" : a.type === "lodging_receipt" ? "🏨" : a.type === "toll_receipt" ? "🛣️" : a.type === "local_receipt" ? "🧾" : a.type === "map_capture" ? "🗺️" : "📄"}</span>
                        <span className="font-medium truncate flex-1">{a.fileName}</span>
                        <span className="text-gray-500">{a.category}</span>
                        {metroMatch && <span className="text-emerald-600 font-bold">✅ {a.proofMetro}</span>}
                        {a.isProof && !metroMatch && a.type !== "rail_receipt" && a.type !== "toll_receipt" && (
                          <span className="text-amber-500">📍 {a.proofMetro || "지역미확인"}</span>
                        )}
                        <button onClick={() => u("attachments", trip.attachments.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">✕</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 관외증빙 상태 */}
              {trip.tripType === "outside" && trip.attachments.length === 0 && (
                <div className="bg-red-50 border border-red-200 rounded px-3 py-2 mt-2 text-xs text-red-600">
                  ⚠️ 관외출장은 증빙서류(철도영수증, 숙박영수증, 톨비영수증 또는 현지영수증)를 첨부해야 합니다.
                </div>
              )}
              {trip.tripType === "outside" && trip.attachments.length > 0 && !proofOk && (
                <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-2 text-xs text-amber-700">
                  ⚠️ 현지 영수증의 지역({trip.attachments.find(a => a.proofMetro)?.proofMetro || "미확인"})이 출장지({trip.destinationMetro || "미입력"})와 일치하지 않습니다.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ═══════════════ 정산 표 ═══════════════
const SettlementTable = ({ trips, userName, userGrade }) => {
  const tableRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const isExec = userGrade === "executive";

  const rows = useMemo(() => trips.map((t) => {
    const isDomestic = t.tripType !== "outside";
    const route = t.legs.map((l) => l.from).concat(t.legs.length > 0 ? [t.legs[t.legs.length - 1].to] : []).filter(Boolean).join("→");

    if (isDomestic) {
      const fixed = t.tripType === "domestic_short" ? DOMESTIC_SHORT : DOMESTIC_LONG;
      const domesticRoute = t.destination ? `식품안전정보원→${t.destination}` : (route || "-");
      return { date: t.date, type: t.tripType === "domestic_short" ? "관내(4h미만)" : "관내(4h이상)", route: domesticRoute, transport: "-", daily: 0, meal: 0, fare: 0, lodging: 0, total: fixed, fixed, note: "", farePayMethod: "personal", lodgingPayMethod: "personal", proofOk: true };
    }

    const fare = t.legs.reduce((s, l) => s + legFare(l), 0);
    const mc = t.noMeal ? 3 : [t.breakfast, t.lunch, t.dinner].filter(Boolean).length;
    const meal = t.noMeal ? 0 : Math.max(0, Math.floor(MEAL_ALLOWANCE - MEAL_DEDUCTION * mc));
    const hasOffCar = t.legs.some((l) => l.transport === "official_car");
    const daily = hasOffCar ? DAILY_ALLOWANCE_HALF : DAILY_ALLOWANCE;

    let lodging = 0;
    if (!t.noLodging) {
      if (isExec) lodging = t.lodgingAmount || 0;
      else lodging = Math.min(t.lodgingAmount || 0, LODGING_LIMITS_STAFF[t.lodgingRegion] || 70000);
    }

    const transports = [...new Set(t.legs.map((l) => l.transport))];
    let transportLabel;
    if (transports.length === 1) {
      const tp = transports[0];
      if (tp === "rail") transportLabel = t.legs.map((l) => l.trainNo).filter(Boolean).join("/") || "철도";
      else if (tp === "personal_car") transportLabel = `자가용(${t.legs.reduce((s, l) => s + (l.km || 0), 0)}km)`;
      else transportLabel = TRANSPORT_TYPES.find((x) => x.value === tp)?.label || tp;
    } else {
      transportLabel = transports.map((tp) => TRANSPORT_TYPES.find((x) => x.value === tp)?.icon || "").join("");
    }

    const notes = [];
    if (hasOffCar) notes.push("공용차량(일비50%)");
    if (t.noMeal) notes.push("식비 해당없음");

    const hasRail = t.attachments.some((a) => a.type === "rail_receipt");
    const hasToll = t.attachments.some((a) => a.type === "toll_receipt");
    const hasLocal = t.attachments.some((a) => a.type === "local_receipt" && a.proofMetro === t.destinationMetro);
    const hasLodg = t.attachments.some((a) => a.type === "lodging_receipt" && a.proofMetro === t.destinationMetro);
    const proofOk = hasRail || hasToll || hasLocal || hasLodg;
    if (!proofOk) notes.push("⚠️증빙 미확인");

    return {
      date: t.date, type: "관외", route, transport: transportLabel, daily, meal, fare, lodging,
      total: fare + daily + meal + lodging, fixed: 0, note: notes.join(", "),
      farePayMethod: t.farePayMethod, lodgingPayMethod: t.lodgingPayMethod, proofOk
    };
  }), [trips, isExec]);

  const totals = useMemo(() => rows.reduce((s, r) => ({
    daily: s.daily + r.daily, meal: s.meal + r.meal, fare: s.fare + (r.fixed || r.fare), lodging: s.lodging + r.lodging, total: s.total + r.total
  }), { daily: 0, meal: 0, fare: 0, lodging: 0, total: 0 }), [rows]);

  const paymentSummary = useMemo(() => {
    let personalDeposit = 0;
    let corpCard = 0;
    rows.forEach((r) => {
      personalDeposit += r.daily + r.meal;
      if (r.fixed) { personalDeposit += r.fixed; return; }
      if (r.fare > 0) { if (r.farePayMethod === "corp_card") corpCard += r.fare; else personalDeposit += r.fare; }
      if (r.lodging > 0) { if (r.lodgingPayMethod === "corp_card") corpCard += r.lodging; else personalDeposit += r.lodging; }
    });
    return { personalDeposit, corpCard };
  }, [rows]);

  // 첨부 목록
  const allAttachments = useMemo(() => {
    const list = [];
    trips.forEach((t, i) => {
      t.attachments.forEach((a) => {
        list.push({ tripIndex: i + 1, fileName: a.fileName, category: a.category });
      });
    });
    return list;
  }, [trips]);

  const handleCopy = () => {
    if (!tableRef.current) return;
    const range = document.createRange();
    range.selectNodeContents(tableRef.current);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("copy");
    sel.removeAllRanges();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const cs = { border: "1px solid #999", padding: "4px 6px", textAlign: "center", fontSize: "11px" };
  const hs = { ...cs, backgroundColor: "#f3f4f6", fontWeight: "bold" };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">📋 여비정산 내역표</h2>
        <button onClick={handleCopy} className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${copied ? "bg-emerald-600 text-white" : "bg-blue-600 text-white hover:bg-blue-700"}`}>
          {copied ? "✅ 복사 완료!" : "📋 표 복사하기"}
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-2">그룹웨어에 Ctrl+V로 붙여넣기</p>

      <div className="overflow-x-auto border border-gray-300 rounded-lg">
        <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Malgun Gothic', sans-serif" }}>
          <thead>
            <tr><td colSpan={10} style={{ ...cs, textAlign: "left", fontSize: "10px", backgroundColor: "#f9fafb", color: "#6b7280" }}>
              소속: 식품안전정보원 | 직급: {isExec ? "임원" : "직원"} | 성명: {userName || "(미입력)"} | 예산항목: 국내여비
            </td></tr>
            <tr>{["일자", "구분", "경로", "교통편", "일비", "식비", "운임", "숙박비", "합계", "비고"].map((h) => <td key={h} style={hs}>{h}</td>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={!r.proofOk && !r.fixed ? { backgroundColor: "#fef2f2" } : {}}>
                <td style={cs}>{r.date ? r.date.slice(5).replace("-", "/") : ""}</td>
                <td style={cs}>{r.type}</td>
                <td style={{ ...cs, fontSize: "10px", maxWidth: "140px", wordBreak: "break-all" }}>{r.route}</td>
                <td style={{ ...cs, fontSize: "10px", maxWidth: "90px" }}>{r.transport}</td>
                <td style={cs}>{r.fixed ? "—" : r.daily.toLocaleString()}</td>
                <td style={cs}>{r.fixed ? "—" : (r.meal > 0 ? r.meal.toLocaleString() : "0")}</td>
                <td style={cs}>{r.fixed ? r.fixed.toLocaleString() : r.fare.toLocaleString()}</td>
                <td style={cs}>{r.fixed || !r.lodging ? "—" : r.lodging.toLocaleString()}</td>
                <td style={{ ...cs, fontWeight: "bold" }}>{r.total.toLocaleString()}</td>
                <td style={{ ...cs, fontSize: "9px", maxWidth: "140px" }}>{r.note}</td>
              </tr>
            ))}
            {/* 합계 */}
            <tr style={{ backgroundColor: "#eff6ff" }}>
              <td colSpan={4} style={{ ...cs, fontWeight: "bold", textAlign: "right" }}>합 계</td>
              <td style={{ ...cs, fontWeight: "bold" }}>{totals.daily > 0 ? totals.daily.toLocaleString() : "—"}</td>
              <td style={{ ...cs, fontWeight: "bold" }}>{totals.meal > 0 ? totals.meal.toLocaleString() : "0"}</td>
              <td style={{ ...cs, fontWeight: "bold" }}>{totals.fare.toLocaleString()}</td>
              <td style={{ ...cs, fontWeight: "bold" }}>{totals.lodging > 0 ? totals.lodging.toLocaleString() : "—"}</td>
              <td style={{ ...cs, fontWeight: "bold", color: "#1d4ed8" }}>{totals.total.toLocaleString()}</td>
              <td style={cs}></td>
            </tr>
            {/* 총 신청금액 */}
            <tr><td colSpan={10} style={{ ...cs, textAlign: "center", fontWeight: "bold", fontSize: "12px" }}>
              총 여비: 금 {totals.total.toLocaleString()}원정 ({amountToKorean(totals.total)}원)
            </td></tr>

            {/* 지급 구분 요약 */}
            <tr><td colSpan={10} style={{ border: "none", padding: "6px 0 0", backgroundColor: "#fff" }}></td></tr>
            <tr><td colSpan={10} style={{ ...hs, textAlign: "left" }}>■ 지급 구분</td></tr>
            <tr>
              <td colSpan={3} style={hs}>구분</td>
              <td colSpan={3} style={hs}>항목</td>
              <td colSpan={2} style={hs}>금액</td>
              <td colSpan={2} style={hs}>비고</td>
            </tr>
            <tr style={{ backgroundColor: "#ecfdf5" }}>
              <td colSpan={3} style={{ ...cs, fontWeight: "bold", color: "#059669" }}>🏦 개인정산 (통장입금)</td>
              <td colSpan={3} style={{ ...cs, textAlign: "left" }}>일비 + 식비{paymentSummary.personalDeposit > totals.daily + totals.meal ? " + 개인결제 실비" : ""}</td>
              <td colSpan={2} style={{ ...cs, fontWeight: "bold", fontSize: "12px", color: "#059669" }}>{paymentSummary.personalDeposit.toLocaleString()}원</td>
              <td colSpan={2} style={{ ...cs, fontSize: "9px" }}>급여계좌 입금</td>
            </tr>
            <tr style={{ backgroundColor: "#eff6ff" }}>
              <td colSpan={3} style={{ ...cs, fontWeight: "bold", color: "#2563eb" }}>💳 기관결제 (법인카드)</td>
              <td colSpan={3} style={{ ...cs, textAlign: "left" }}>운임 + 숙박비 (법인카드 결제분)</td>
              <td colSpan={2} style={{ ...cs, fontWeight: "bold", fontSize: "12px", color: "#2563eb" }}>{paymentSummary.corpCard > 0 ? paymentSummary.corpCard.toLocaleString() + "원" : "—"}</td>
              <td colSpan={2} style={{ ...cs, fontSize: "9px" }}>{paymentSummary.corpCard > 0 ? "기 결제 확인" : ""}</td>
            </tr>

            {/* 첨부 목록 */}
            {allAttachments.length > 0 && (
              <>
                <tr><td colSpan={10} style={{ border: "none", padding: "6px 0 0", backgroundColor: "#fff" }}></td></tr>
                <tr><td colSpan={10} style={{ ...hs, textAlign: "left" }}>■ 첨부서류 목록</td></tr>
                <tr>
                  <td colSpan={1} style={hs}>No.</td>
                  <td colSpan={1} style={hs}>출장</td>
                  <td colSpan={5} style={hs}>파일명</td>
                  <td colSpan={3} style={hs}>종류</td>
                </tr>
                {allAttachments.map((a, i) => (
                  <tr key={i}>
                    <td colSpan={1} style={cs}>{i + 1}</td>
                    <td colSpan={1} style={cs}>#{a.tripIndex}</td>
                    <td colSpan={5} style={{ ...cs, textAlign: "left", fontSize: "10px" }}>{a.fileName}</td>
                    <td colSpan={3} style={{ ...cs, fontSize: "10px" }}>{a.category}</td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ═══════════════ 메인 앱 ═══════════════
export default function TravelExpenseV5() {
  const [userName, setUserName] = useState("");
  const [userGrade, setUserGrade] = useState("staff");
  const [trips, setTrips] = useState([emptyTrip()]);
  const [showTable, setShowTable] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  const isExec = userGrade === "executive";

  const addTrip = () => setTrips((p) => [...p, emptyTrip()]);
  const removeTrip = (id) => setTrips((p) => p.length > 1 ? p.filter((t) => t.id !== id) : p);
  const updateTrip = useCallback((id, key, val) => setTrips((p) => p.map((t) => t.id === id ? { ...t, [key]: val } : t)), []);

  const analyzeFile = useCallback(async (tripId, file) => {
    setAnalyzing(true);
    try {
      const result = await analyzeWithClaude(file);
      setTrips((prev) => prev.map((t) => {
        if (t.id !== tripId) return t;
        const att = { fileName: file.name, category: result.category, type: result.type, proofMetro: result.proofMetro, isProof: result.isProof, simulated: result.simulated || false };
        let updated = { ...t, attachments: [...t.attachments, att] };

        if (result.type === "rail_receipt" && result.data) {
          const d = result.data;
          const newLeg = { ...emptyLeg(), from: d.from || "", to: d.to || "", transport: "rail", trainNo: d.trainNo || "", amount: d.amount || 0 };
          if (updated.legs.length === 1 && !updated.legs[0].from && !updated.legs[0].to) {
            updated.legs = [{ ...updated.legs[0], ...newLeg, id: updated.legs[0].id }];
          } else {
            updated.legs = [...updated.legs, newLeg];
          }
        }

        if (result.type === "lodging_receipt" && result.data) {
          const d = result.data;
          updated.lodgingAmount = d.amount || updated.lodgingAmount;
          updated.noLodging = false;
          if (d.address) {
            const metro = detectMetro(d.address);
            if (metro) updated.lodgingRegion = getLodgingRegion(metro);
          }
        }

        if (result.type === "toll_receipt" && result.data) {
          const existingTollLeg = updated.legs.find((l) => (l.transport === "personal_car" || l.transport === "official_car"));
          if (existingTollLeg) {
            updated.legs = updated.legs.map((l) => l.id === existingTollLeg.id ? { ...l, tollFee: (l.tollFee || 0) + (result.data.amount || 0) } : l);
          }
        }

        if (result.type === "map_capture" && result.data) {
          const d = result.data;
          const carLeg = updated.legs.find((l) => l.transport === "personal_car");
          if (carLeg) {
            updated.legs = updated.legs.map((l) => l.id === carLeg.id ? { ...l, km: d.distanceKm || l.km, from: d.from || l.from, to: d.to || l.to } : l);
          }
        }

        return updated;
      }));
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // v5: 일괄 업로드 결과 반영
  const handleBulkComplete = useCallback((newTrips) => {
    if (newTrips.length === 0) return;
    setTrips((prev) => {
      // 기존에 빈 출장 1개만 있으면 교체, 아니면 추가
      const isEmpty = prev.length === 1 && !prev[0].date && !prev[0].destination && prev[0].attachments.length === 0;
      return isEmpty ? newTrips : [...prev, ...newTrips];
    });
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* 헤더 */}
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">식품안전정보원 여비정산</h1>
          <p className="text-xs text-gray-500 mt-1">v5 — 영수증 일괄 분석 · AI 자동 출장 생성</p>
        </div>

        {/* 인적사항 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">성명</label>
              <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="홍길동" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">직급</label>
              <div className="flex gap-2">
                {[["executive", "👔 임원"], ["staff", "👤 직원"]].map(([val, label]) => (
                  <button key={val} onClick={() => setUserGrade(val)}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-all ${userGrade === val ? "bg-slate-700 text-white border-slate-700" : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {isExec && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-700">
              👔 임원 적용: KTX 특실 이용 가능 · 숙박비 상한 없음 (실비 정산)
            </div>
          )}
        </div>

        {/* v5: 일괄 업로드 버튼 */}
        <button onClick={() => setShowBulkModal(true)}
          className="w-full mb-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl text-sm font-semibold hover:from-violet-700 hover:to-indigo-700 transition-all shadow-sm">
          🤖 영수증 일괄 분석 → 출장 자동 생성
        </button>

        {/* 출장 카드 목록 */}
        <div className="space-y-4 mb-4">
          {trips.map((trip, i) => (
            <TripCard key={trip.id} trip={trip} index={i} onUpdate={updateTrip} onRemove={removeTrip}
              canRemove={trips.length > 1} isExecutive={isExec} analyzing={analyzing} onAnalyzeFile={analyzeFile} />
          ))}
        </div>

        {/* 출장 추가 + 정산 버튼 */}
        <div className="flex gap-2 mb-6">
          <button onClick={addTrip} className="flex-1 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-all">
            + 출장 추가
          </button>
          <button onClick={() => setShowTable(!showTable)}
            className="flex-1 py-3 bg-slate-700 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 transition-all">
            {showTable ? "입력으로 돌아가기" : "📋 정산 내역표 보기"}
          </button>
        </div>

        {/* 정산표 */}
        {showTable && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
            <SettlementTable trips={trips} userName={userName} userGrade={userGrade} />
          </div>
        )}
      </div>

      {/* v5: 일괄 업로드 모달 */}
      <BulkUploadModal
        isOpen={showBulkModal}
        onClose={() => setShowBulkModal(false)}
        onComplete={handleBulkComplete}
        analyzing={analyzing}
      />
    </div>
  );
}