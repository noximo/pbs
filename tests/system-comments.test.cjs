const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/../pbs.user.js`, 'utf8');
const patterns = source.slice(source.indexOf('    const systemCommentPatterns'), source.indexOf('    const checkingTaskIds'));
const functions = source.slice(source.indexOf('    function normalizeText'), source.indexOf('    function checkPostRequest'));
const context = vm.createContext({
    // Supply the line-preserving text returned by the DOM extraction helper.
    getCommentTextWithLineBreaks: content => content.text,
});
vm.runInContext(`${patterns}\n${functions}`, context);

function classify(text, media = false) {
    return context.isSystemCommentContent({ text, querySelector: () => media ? {} : null });
}

for (const prefix of ['Přidáno:', 'Změna času spolupracovníka', 'Uživatel požádal o čas', 'Změna autora', 'Předáno:']) {
    assert.equal(classify(`${prefix} Tomáš Pospíšil`), true);
    assert.equal(classify(`${prefix} Tomáš Pospíšil\n\nreakce ze zadání jednotlivě:\nDalší text`), false);
}
assert.equal(classify('Předáno: Katka Labošová\n@Katka Labošová\nreakce ze zadání jednotlivě:'), false);
assert.equal(classify('\n Předáno: Tomáš Pospíšil\n\n'), true);
assert.equal(classify('Předáno: Tomáš Pospíšil\nZměna autora: Katka Labošová'), true);
assert.equal(classify('Běžný komentář'), false);
assert.equal(classify(''), false);
assert.equal(classify('Předáno: Tomáš Pospíšil', true), false);
console.log('System comment classification checks passed.');
