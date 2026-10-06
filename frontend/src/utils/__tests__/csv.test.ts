import { parseCsv } from '../csv';

describe('parseCsv', () => {
  it('splits rows and cells', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('keeps commas, newlines and doubled quotes inside quoted cells', () => {
    const text = 'Subject,Comments\n"Calling All Shiny Pennies, Again","Line one\nLine ""two"""\n';
    expect(parseCsv(text)).toEqual([
      ['Subject', 'Comments'],
      ['Calling All Shiny Pennies, Again', 'Line one\nLine "two"'],
    ]);
  });

  it('handles CRLF line ends, a BOM, blank rows and empty cells', () => {
    expect(parseCsv('﻿a,b\r\n\r\n,x\r\n,,\r\nlast,')).toEqual([['a', 'b'], ['', 'x'], ['last', '']]);
  });
});
