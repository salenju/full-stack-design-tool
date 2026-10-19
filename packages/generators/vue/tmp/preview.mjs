import { buildFixture } from '@fsdt/core-ir/testing';
import { vueGenerator } from '@fsdt/generator-vue';

const { ir } = buildFixture();
const plans = vueGenerator.plan(ir, { projectName: 'demo', outputRoot: '/tmp/out' });
console.log(plans.map((p) => `${p.kind.padEnd(10)} ${p.path}`).join('\n'));
console.log('---');
for (const plan of plans) {
  if (plan.path === 'src/views/devices.vue') {
    const f = await vueGenerator.render(plan, ir, { projectName: 'demo', outputRoot: '/tmp/out' });
    console.log(f.content);
  }
}
