import assert from 'node:assert/strict';

export async function assertIconControls(page, root = 'body') {
  const controls = await page.locator(root).locator('.icon-button, .send-button').evaluateAll(buttons => buttons
    .filter(button => button.getBoundingClientRect().width > 0)
    .map(button => {
      const style = getComputedStyle(button), box = button.getBoundingClientRect();
      const icon = button.querySelector('svg'), stroke = icon && getComputedStyle(icon);
      return {
        name: button.getAttribute('aria-label'), tooltip: button.title,
        width: box.width, height: box.height, radius: style.borderRadius,
        background: style.backgroundColor, padding: style.padding,
        stroke: stroke && [stroke.strokeWidth, stroke.strokeLinecap, stroke.strokeLinejoin],
      };
    }));
  assert.ok(controls.length > 0, `${root}: icon controls are present`);
  for (const control of controls) {
    assert.ok(control.name && control.tooltip, 'Every icon action has an accessible name and tooltip');
    assert.ok(Math.abs(control.width - control.height) < 1 && control.width >= 28, `${control.name}: square hit area, at least 28px`);
    assert.equal(control.radius, '50%', `${control.name}: circular button`);
    assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(control.background), `${control.name}: visible surface`);
    assert.deepEqual(control.stroke, ['1.7px', 'round', 'round'], `${control.name}: consistent rounded outline`);
  }
  return 1 + controls.length * 5;
}
