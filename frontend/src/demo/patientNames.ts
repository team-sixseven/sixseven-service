const surnames = ['김', '이', '박', '최', '정', '강', '조', '윤', '장'];
const maleNames = ['민준', '서준', '도윤', '시우', '지호', '현우', '준서', '건우', '우진', '지훈'];
const femaleNames = ['서연', '서윤', '지우', '하윤', '지민', '수빈', '지유', '예은', '채원', '은서'];

// Display aliases only. IDs and every model input remain unchanged.
export function patientDisplayName(patient: { id: string; name: string; sex?: string }, musicMode: boolean): string {
  if (!musicMode || !/^T(?:0[1-9]|[1-8][0-9])$/.test(patient.id)) return patient.name;
  const index = Number(patient.id.slice(1)) - 1;
  const givenNames = patient.sex === 'F' ? femaleNames : maleNames;
  return surnames[Math.floor(index / 10)] + givenNames[index % 10];
}
