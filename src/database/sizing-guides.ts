/**
 * Sizing guides seeded into the categories that sell sized goods. A guide is
 * shown to customers, Market Associates and Partners whenever a product in the
 * category (or its sub-category) has a size to choose. Admins can switch a
 * guide off or edit it from the category page.
 */
export interface SeedSizingGuide {
  enabled: boolean;
  summary: string;
  howToMeasure: string;
  presetGroups: Array<'clothing' | 'uk-dress' | 'shoes' | 'kids-shoes' | 'bra' | 'general'>;
  chart: Array<{ size: string; measurements: Record<string, string> }>;
}

const shoeRows: Array<[string, string, string]> = [
  ['36', '22.9 cm', '3.5'], ['37', '23.5 cm', '4'], ['38', '24.1 cm', '5'], ['39', '24.8 cm', '6'], ['40', '25.4 cm', '6.5'], ['41', '26.0 cm', '7.5'],
  ['42', '26.7 cm', '8'], ['43', '27.3 cm', '9'], ['44', '27.9 cm', '9.5'], ['45', '28.6 cm', '10.5'], ['46', '29.2 cm', '11'],
];

export const SHOE_GUIDE: SeedSizingGuide = {
  enabled: true,
  summary: 'EU sizes. If you are between two sizes, choose the larger one.',
  howToMeasure: 'Stand on a sheet of paper and mark the tip of your longest toe and the back of your heel. Measure the distance in centimetres and match it to the foot length below.',
  presetGroups: ['shoes'],
  chart: shoeRows.map(([size, length, uk]) => ({ size, measurements: { 'Foot length': length, UK: uk } })),
};

export const KIDS_SHOE_GUIDE: SeedSizingGuide = {
  enabled: true,
  summary: 'EU kids sizes. Leave about 1 cm of growing room.',
  howToMeasure: 'Have your child stand on paper, mark the longest toe and the heel, then measure the distance. Add about 1 cm for growth and match it to the chart.',
  presetGroups: ['kids-shoes'],
  chart: Array.from({ length: 16 }, (_, index) => {
    const eu = 20 + index;
    return { size: String(eu), measurements: { 'Foot length': `${(eu / 1.5 - 1.5).toFixed(1)} cm` } };
  }),
};

export const CLOTHING_GUIDE: SeedSizingGuide = {
  enabled: true,
  summary: 'Body measurements in centimetres. Choose the size that matches your chest.',
  howToMeasure: 'Measure around the fullest part of your chest and around your natural waist, keeping the tape snug but not tight. If you are between sizes, go up one.',
  presetGroups: ['clothing'],
  chart: [
    ['XS', '82 - 87', '66 - 71'], ['S', '88 - 93', '72 - 77'], ['M', '94 - 99', '78 - 83'], ['L', '100 - 105', '84 - 89'],
    ['XL', '106 - 111', '90 - 95'], ['2XL', '112 - 119', '96 - 103'], ['3XL', '120 - 127', '104 - 111'],
  ].map(([size, chest, waist]) => ({ size, measurements: { Chest: `${chest} cm`, Waist: `${waist} cm` } })),
};

export const UK_DRESS_GUIDE: SeedSizingGuide = {
  enabled: true,
  summary: 'UK dress sizes with approximate body measurements in centimetres. If you are between sizes, choose the larger one.',
  howToMeasure: 'Measure around the fullest part of your bust, your natural waist (the narrowest part of your torso) and the fullest part of your hips, keeping the tape snug but not tight.',
  presetGroups: ['uk-dress'],
  chart: [
    ['6', '80', '62', '87'], ['8', '84', '66', '91'], ['10', '88', '70', '95'], ['12', '92', '74', '99'],
    ['14', '97', '79', '104'], ['16', '102', '84', '109'], ['18', '107', '89', '114'],
  ].map(([size, bust, waist, hips]) => ({ size, measurements: { Bust: `${bust} cm`, Waist: `${waist} cm`, Hips: `${hips} cm` } })),
};

export const BRA_GUIDE: SeedSizingGuide = {
  enabled: true,
  summary: 'Band size (number) plus cup size (letter).',
  howToMeasure: 'Measure firmly around your ribcage just under the bust for the band. Measure around the fullest part of the bust for the cup: each 2.5 cm more than the band is one cup size (A, B, C, D).',
  presetGroups: ['bra'],
  chart: [
    ['32', '71 - 75 cm'], ['34', '76 - 80 cm'], ['36', '81 - 85 cm'], ['38', '86 - 90 cm'], ['40', '91 - 95 cm'],
  ].map(([size, band]) => ({ size, measurements: { 'Band (ribcage)': band, 'Cup A': 'bust +2.5 cm', 'Cup B': 'bust +5 cm', 'Cup C': 'bust +7.5 cm', 'Cup D': 'bust +10 cm' } })),
};
