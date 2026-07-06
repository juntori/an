// 테마팩 1호 — 과일 농장 (Fruit Farm)
// 엔진과 분리된 콘텐츠 데이터. 2호 팩은 이 스키마로 파일만 추가한다.
export const PACK = {
  id: 'fruit-farm',
  title: '과일 농장',
  character: { emoji: '🐰', name: 'Bunny' },
  // 목표 단어 10개 = 과일 8 + 동작 동사 2 (pick, wash)
  scenarios: [
    {
      id: 'pick',
      title: '과일 따기',
      gesture: 'grab',
      gestureHintKo: '손을 펴서 과일에 대고, 주먹을 꼭 쥐어요!',
      scene: 'tree',
      introEn: "I'm so hungry! Can you pick some fruit for me?",
      introKo: '배가 너무 고파! 과일 좀 따 줄래?',
      verb: {
        en: 'pick', ko: '따다', emoji: '🫳',
        accept: ['pick', 'pic', 'big', 'pig', 'peek'],
        promptEn: 'Pick! Say: Pick!',
        promptKo: '"픽!" — 따다',
      },
      items: [
        {
          en: 'apple', ko: '사과', emoji: '🍎', pos: { x: 0.72, y: 0.30 },
          accept: ['apple', 'apples', 'appel', 'apel', 'apple e'],
          askEn: 'Ooh, the red one! Pick the apple!', askKo: '우와, 빨간 거! 사과를 따 줘!',
        },
        {
          en: 'orange', ko: '오렌지', emoji: '🍊', pos: { x: 0.55, y: 0.22 },
          accept: ['orange', 'oranges', 'orang', 'aranj'],
          askEn: 'Now the orange one! Pick the orange!', askKo: '이번엔 주황색! 오렌지를 따 줘!',
        },
        {
          en: 'peach', ko: '복숭아', emoji: '🍑', pos: { x: 0.86, y: 0.20 },
          accept: ['peach', 'peaches', 'pitch', 'beach', 'peach is'],
          askEn: 'One more! Pick the peach!', askKo: '하나 더! 복숭아를 따 줘!',
        },
      ],
      clearEn: 'Yummy! Thank you so much!', clearKo: '냠냠! 정말 고마워!',
    },
    {
      id: 'wash',
      title: '과일 씻기',
      gesture: 'wash',
      gestureHintKo: '손을 펴서 과일 위에서 싹싹 문질러요!',
      scene: 'basin',
      introEn: "Wait! The fruits are dirty. Let's wash them!",
      introKo: '잠깐! 과일이 더러워. 우리 같이 씻자!',
      verb: {
        en: 'wash', ko: '씻다', emoji: '🫧',
        accept: ['wash', 'watch', 'wash it', 'walsh', 'was'],
        promptEn: 'Wash! Say: Wash!',
        promptKo: '"워시!" — 씻다',
      },
      items: [
        {
          en: 'grape', ko: '포도', emoji: '🍇', pos: { x: 0.30, y: 0.55 },
          accept: ['grape', 'grapes', 'great', 'grip', 'grape s'],
          askEn: 'Scrub scrub! Wash the grapes!', askKo: '싹싹! 포도를 씻어 줘!',
        },
        {
          en: 'strawberry', ko: '딸기', emoji: '🍓', pos: { x: 0.52, y: 0.58 },
          accept: ['strawberry', 'strawberries', 'strawbery', 'berry', 'straw berry'],
          askEn: 'Now wash the strawberry!', askKo: '이번엔 딸기를 씻어 줘!',
        },
        {
          en: 'pear', ko: '배', emoji: '🍐', pos: { x: 0.73, y: 0.55 },
          accept: ['pear', 'pears', 'pair', 'bear', 'per'],
          askEn: 'Last one! Wash the pear!', askKo: '마지막! 배를 씻어 줘!',
        },
      ],
      clearEn: 'So clean! Sparkly sparkly!', clearKo: '깨끗해졌다! 반짝반짝!',
    },
    {
      id: 'basket',
      title: '바구니에 담기',
      gesture: 'carry',
      gestureHintKo: '과일을 꼭 쥐고, 바구니까지 옮겨요!',
      scene: 'basket',
      introEn: "Let's put the fruits in the basket for our picnic!",
      introKo: '소풍 가게 과일을 바구니에 담자!',
      verb: null, // 3번 시나리오는 복습 스테이지 — 새 동사 없음
      items: [
        {
          en: 'banana', ko: '바나나', emoji: '🍌', pos: { x: 0.22, y: 0.40 },
          accept: ['banana', 'bananas', 'banna', 'nana', 'banan'],
          askEn: 'Grab the banana and put it in!', askKo: '바나나를 잡아서 바구니에 넣어 줘!',
        },
        {
          en: 'watermelon', ko: '수박', emoji: '🍉', pos: { x: 0.30, y: 0.62 },
          accept: ['watermelon', 'water melon', 'melon', 'water'],
          askEn: 'Wow, the big one! The watermelon!', askKo: '우와, 큰 거! 수박을 옮겨 줘!',
        },
      ],
      clearEn: 'All packed! Time for a picnic!', clearKo: '다 담았다! 소풍 가자!',
    },
  ],
  finaleEn: 'You did it! You are my best friend!',
  finaleKo: '해냈어! 넌 최고의 친구야!',
};
