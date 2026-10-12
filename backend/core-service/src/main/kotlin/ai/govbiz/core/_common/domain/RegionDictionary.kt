package ai.govbiz.core._common.domain

import java.text.Normalizer

/**
 * 회사 소재지·대화 조건의 지역 표기를 공고 지역 태그·모집글 희망 지역과 같은 시·도 이름으로 해석하는 결정적 지역 사전입니다.
 *
 * 2026-10 기준 행정구역(대구 군위군, 화성 4개 일반구, 인천 제물포·영종·서해·검단구, 전남광주통합특별시)을
 * 반영합니다. 지원사업 검색 결과 정렬·표시, 대화 조건의 표기 비교, 파트너 맞춤 추천의 회사 지역과 Gov 파트너 조건 근거
 * 확인에 쓰며 신청 자격을 판정하지 않습니다.
 */
object RegionDictionary {
    private const val NATIONWIDE = "전국"
    private const val INTEGRATED_GWANGJU_JEONNAM = "전남광주"
    private val SEPARATORS = Regex("[\\s,·/]+")

    /** "서울 지역", "부산 소재"처럼 지역 이름 뒤에 붙는 일반 낱말은 비교에서 뺍니다. */
    private val GENERIC_TOKENS = setOf("지역", "소재", "소재지", "관내", "일대")

    private val ALIASES_BY_PROVINCE: Map<String, List<String>> = mapOf(
        "서울" to listOf("서울", "서울시", "서울특별시"),
        "부산" to listOf("부산", "부산시", "부산광역시"),
        "대구" to listOf("대구", "대구시", "대구광역시"),
        "인천" to listOf("인천", "인천시", "인천광역시"),
        // 경기 광주시와 겹치는 "광주시"는 시·군 사전에서 두 시·도 후보로 다룹니다.
        "광주" to listOf("광주", "광주광역시"),
        "대전" to listOf("대전", "대전시", "대전광역시"),
        "울산" to listOf("울산", "울산시", "울산광역시"),
        "세종" to listOf("세종", "세종시", "세종특별자치시"),
        "경기" to listOf("경기", "경기도"),
        "강원" to listOf("강원", "강원도", "강원특별자치도"),
        "충북" to listOf("충북", "충청북도"),
        "충남" to listOf("충남", "충청남도"),
        "전북" to listOf("전북", "전라북도", "전북특별자치도"),
        "전남" to listOf("전남", "전라남도"),
        "경북" to listOf("경북", "경상북도"),
        "경남" to listOf("경남", "경상남도"),
        "제주" to listOf("제주", "제주도", "제주특별자치도"),
    )

    /** 공고 지역 태그와 모집글 희망 지역에 쓰는 17개 시·도 짧은 이름입니다. */
    val PROVINCES: List<String> = ALIASES_BY_PROVINCE.keys.toList()

    private val PROVINCE_ALIASES: Map<String, String> =
        ALIASES_BY_PROVINCE.flatMap { (province, aliases) -> aliases.map { it to province } }.toMap()

    /** 2026-07-01 출범한 전남광주통합특별시는 공고 태그의 광주·전남을 함께 뜻합니다. */
    private val INTEGRATED_ALIASES = setOf("전남광주통합특별시", "전남광주특별시", "광주특별시", "전남광주", "광주전남")

    private val AREAS: Map<String, Set<String>> = mapOf(
        "수도권" to setOf("서울", "인천", "경기"),
        "충청권" to setOf("대전", "세종", "충북", "충남"),
        "중부권" to setOf("대전", "세종", "충북", "충남"),
        "충청도" to setOf("대전", "세종", "충북", "충남"),
        "호남권" to setOf("광주", "전북", "전남"),
        "전라도" to setOf("광주", "전북", "전남"),
        "영남권" to setOf("부산", "대구", "울산", "경북", "경남"),
        "경상도" to setOf("부산", "대구", "울산", "경북", "경남"),
        "동남권" to setOf("부산", "울산", "경남"),
        "부울경" to setOf("부산", "울산", "경남"),
        "대경권" to setOf("대구", "경북"),
        "강원권" to setOf("강원"),
        "제주권" to setOf("제주"),
    )

    /** 시·도별 시·군·자치구와 행정시·일반구입니다. 같은 이름(중구·고성군 등)은 여러 시·도 후보가 됩니다. */
    private val DISTRICTS_BY_PROVINCE: Map<String, List<String>> = mapOf(
        "서울" to "종로구 중구 용산구 성동구 광진구 동대문구 중랑구 성북구 강북구 도봉구 노원구 은평구 서대문구 " +
            "마포구 양천구 강서구 구로구 금천구 영등포구 동작구 관악구 서초구 강남구 송파구 강동구",
        "부산" to "중구 서구 동구 영도구 부산진구 동래구 남구 북구 해운대구 사하구 금정구 강서구 연제구 수영구 사상구 기장군",
        "대구" to "중구 동구 서구 남구 북구 수성구 달서구 달성군 군위군",
        "인천" to "제물포구 영종구 미추홀구 연수구 남동구 부평구 계양구 서해구 검단구 강화군 옹진군",
        "광주" to "동구 서구 남구 북구 광산구 광주시",
        "대전" to "동구 중구 서구 유성구 대덕구",
        "울산" to "중구 남구 동구 북구 울주군",
        "경기" to "수원시 성남시 의정부시 안양시 부천시 광명시 평택시 동두천시 안산시 고양시 과천시 구리시 남양주시 " +
            "오산시 시흥시 군포시 의왕시 하남시 용인시 파주시 이천시 안성시 김포시 화성시 광주시 양주시 포천시 여주시 " +
            "연천군 가평군 양평군 장안구 권선구 팔달구 영통구 수정구 중원구 분당구 만안구 동안구 원미구 소사구 오정구 " +
            "상록구 단원구 덕양구 일산동구 일산서구 처인구 기흥구 수지구 만세구 효행구 병점구 동탄구",
        "강원" to "춘천시 원주시 강릉시 동해시 태백시 속초시 삼척시 홍천군 횡성군 영월군 평창군 정선군 철원군 화천군 " +
            "양구군 인제군 고성군 양양군",
        "충북" to "청주시 충주시 제천시 보은군 옥천군 영동군 증평군 진천군 괴산군 음성군 단양군 상당구 서원구 흥덕구 청원구",
        "충남" to "천안시 공주시 보령시 아산시 서산시 논산시 계룡시 당진시 금산군 부여군 서천군 청양군 홍성군 예산군 " +
            "태안군 동남구 서북구",
        "전북" to "전주시 군산시 익산시 정읍시 남원시 김제시 완주군 진안군 무주군 장수군 임실군 순창군 고창군 부안군 " +
            "완산구 덕진구",
        "전남" to "목포시 여수시 순천시 나주시 광양시 담양군 곡성군 구례군 고흥군 보성군 화순군 장흥군 강진군 해남군 " +
            "영암군 무안군 함평군 영광군 장성군 완도군 진도군 신안군",
        "경북" to "포항시 경주시 김천시 안동시 구미시 영주시 영천시 상주시 문경시 경산시 의성군 청송군 영양군 영덕군 " +
            "청도군 고령군 성주군 칠곡군 예천군 봉화군 울진군 울릉군 남구 북구",
        "경남" to "창원시 진주시 통영시 사천시 김해시 밀양시 거제시 양산시 의령군 함안군 창녕군 고성군 남해군 하동군 " +
            "산청군 함양군 거창군 합천군 의창구 성산구 마산합포구 마산회원구 진해구",
        "제주" to "제주시 서귀포시",
    ).mapValues { (_, names) -> names.split(' ') }

    private val DISTRICT_PROVINCES: Map<String, Set<String>> = DISTRICTS_BY_PROVINCE
        .flatMap { (province, districts) -> districts.map { it to province } }
        .groupBy({ it.first }, { it.second })
        .mapValues { (_, provinces) -> provinces.toSet() }

    /** "강남"처럼 시·군·구를 뺀 두 글자 이상의 이름입니다. 시·도 이름과 겹치는 광주·제주는 시·도로 읽습니다. */
    private val DISTRICT_NAMES_BY_STEM: Map<String, String> = DISTRICT_PROVINCES.keys
        .filter { it.length >= 3 && it.last() in "시군구" }
        .groupBy { it.dropLast(1) }
        .filterKeys { it !in PROVINCE_ALIASES && it !in INTEGRATED_ALIASES && it !in AREAS }
        .filterValues { it.size == 1 }
        .mapValues { (_, names) -> names.single() }

    /** 표기만 다른 같은 지역(서울특별시·서울, 서울시 강남구·서울 강남구, 강남·강남구)인지 확인합니다. */
    fun isSameRegion(left: String?, right: String?): Boolean {
        val leftTokens = canonicalTokens(left)
        return leftTokens.isNotEmpty() && leftTokens == canonicalTokens(right)
    }

    /**
     * 지역 표기를 시·도 이름 집합으로 해석합니다. 시·도나 권역이 있으면 그것만 쓰고, 없을 때만 시·군·구로 찾습니다.
     * 모르는 표기·전국·빈 값은 빈 집합이며, 같은 이름의 시·군·구는 가능한 시·도를 모두 돌려줍니다.
     */
    fun provincesOf(region: String?): Set<String> {
        val tokens = tokens(region)
        val provinces = LinkedHashSet<String>()
        for (token in tokens) {
            PROVINCE_ALIASES[token]?.let(provinces::add)
            if (token in INTEGRATED_ALIASES) provinces += listOf("광주", "전남")
            AREAS[token]?.let(provinces::addAll)
        }
        if (provinces.isNotEmpty()) return provinces
        for (token in tokens) {
            val districtName = if (token in DISTRICT_PROVINCES) token else DISTRICT_NAMES_BY_STEM[token]
            districtName?.let { provinces += DISTRICT_PROVINCES.getValue(it) }
        }
        return provinces
    }

    /**
     * 공고 지역 태그가 전국이 아니고 회사 소재지의 시·도와 하나도 겹치지 않으면 다른 지역 한정일 수 있다고 봅니다.
     * 회사 지역이나 태그를 해석할 수 없으면 판단하지 않습니다. 광주·전남은 통합특별시로 같은 지역으로 봅니다.
     */
    fun isOutsideTaggedRegions(companyRegion: String?, regionTags: List<String>): Boolean {
        val company = withIntegratedArea(provincesOf(companyRegion))
        if (company.isEmpty() || regionTags.any { NATIONWIDE in tokens(it) }) return false
        val tagged = withIntegratedArea(regionTags.flatMapTo(LinkedHashSet(), ::provincesOf))
        return tagged.isNotEmpty() && tagged.none(company::contains)
    }

    private fun withIntegratedArea(provinces: Set<String>): Set<String> =
        if ("광주" in provinces || "전남" in provinces) provinces + setOf("광주", "전남") else provinces

    private fun canonicalTokens(value: String?): List<String> = tokens(value).map { token ->
        PROVINCE_ALIASES[token]
            ?: INTEGRATED_GWANGJU_JEONNAM.takeIf { token in INTEGRATED_ALIASES }
            ?: DISTRICT_NAMES_BY_STEM[token]
            ?: token
    }

    private fun tokens(value: String?): List<String> =
        if (value.isNullOrBlank()) emptyList()
        else Normalizer.normalize(value, Normalizer.Form.NFKC).trim().split(SEPARATORS)
            .filter { it.isNotBlank() && it !in GENERIC_TOKENS }
}
