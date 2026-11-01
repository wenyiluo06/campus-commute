-- =====================================================================
-- 校园通勤提醒 · Supabase 数据库初始化脚本（PostgreSQL）
-- 表 1：user_settings 用户默认设置（学校名称（含校区）/ 默认出发地 /
--       出勤方式 / 提前到课 / 天气提醒 / 到点通知 /
--       学期第一周周一日期 semester_start）
-- 表 2：schedule_data 用户课表（课程名 / 起止时间 / 地点 / 周数文本 weeks，
--       以及结构化周次字段 start_week 起始周次 / end_week 结束周次 /
--       week_type 单双周（all=每周 / odd=单周 / even=双周））
-- 隔离：两张表都通过 user_id（默认 auth.uid()）绑定登录用户，
--       并启用 RLS，用户只能读写自己的数据。
--
-- 执行位置：Supabase 后台 → SQL Editor → 全选粘贴本文件 → Run。
-- 本脚本可反复执行（幂等），新库 / 旧库 / 缺列 / 多列都不会报错。
--
-- ⚠️ 为什么以前会报 42703 还“修不好”：
--   Supabase SQL Editor 把整段脚本当成【一个事务】执行——任何一句报错，
--   整段全部回滚，前面生效的语句也会被撤销。
--   旧版脚本里 `COMMENT ON COLUMN public.user_settings.school` 排在
--   `ALTER TABLE ... ADD COLUMN school` 之前：旧表没有 school 列时，
--   这句 COMMENT 先报 42703 → 整段回滚 → 后面的加列语句从没执行过，
--   于是每次重跑都在同一处失败，school 列永远加不上。
--   本版把所有“引用具体列”的语句（注释、数据迁移）都收进 DO 块，
--   先查 information_schema 确认列存在再执行，从根上杜绝这个问题。
--
-- ⚠️ 后来为什么又报 42846 cannot cast type text[] to integer：
--   PostgreSQL 的 regexp_matches(text, pattern, 'g') 返回 setof text[]，
--   即每一行是【数组】而不是单个字符串。`min(m.n::integer)` 想把数组
--   直接转整数 → 42846 → 同样整段回滚，start_week 列一直加不上。
--   正确写法是取数组第一个元素：`min(m.n[1]::integer)`。
--
-- 自检（跑完本脚本后单独执行）：
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='user_settings'
--    order by ordinal_position;
--   预期 9 列：id / user_id / school / semester_start / default_departure /
--              commute_mode / weather_on / notify_on /
--              created_at
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='schedule_data'
--    order by ordinal_position;
--   预期 11 列：id / user_id / course_name / start_time / end_time /
--               location / weeks / start_week / end_week / week_type /
--               created_at
-- =====================================================================

-- ---------- 表 1：用户默认设置 ----------
-- 新库：直接按最终结构建表（school 为单一字段，有校区就写在一起；
--       semester_start 为学期第一周的周一日期，用于计算当前第几周）。
CREATE TABLE IF NOT EXISTS public.user_settings (
  id                 BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  school             TEXT,        -- 学校名称（有校区就写在一起，如：北京大学昌平校区；用于高德定位拼名）
  semester_start     DATE,        -- 学期第一周的周一日期（YYYY-MM-DD；按它计算当前周数，判断单双周/起止周次）
  default_departure  TEXT,        -- 默认出发地（宿舍 / 家）
  commute_mode       TEXT,        -- 出勤方式（步行 / 骑行 / 校内公交）
  weather_on         BOOLEAN     NOT NULL DEFAULT true,  -- 天气提醒开关
  notify_on          BOOLEAN     NOT NULL DEFAULT true,  -- 到点提醒通知开关
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 旧库补列：前端会读写的每一列都补（可重复执行，已存在则跳过）。
-- 之前只补了 school 等少数列，若你的表是更早版本建的，可能还缺别的列。
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS school            TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS semester_start    DATE;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS default_departure TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS commute_mode      TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS weather_on        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS notify_on         BOOLEAN NOT NULL DEFAULT true;

-- 每个用户最多一行设置（前端 saveSettings 的 upsert 依赖此唯一索引）。
-- 先清理历史重复行，再“先删后建”唯一索引：
-- 防止旧库残留「同名但非唯一」的索引，导致 upsert(onConflict:user_id) 失败。
DELETE FROM public.user_settings u
USING public.user_settings u2
WHERE u.user_id = u2.user_id
  AND u.id < u2.id;

DROP INDEX IF EXISTS public.user_settings_user_id_key;
CREATE UNIQUE INDEX user_settings_user_id_key ON public.user_settings(user_id);

-- 列注释 + 旧列数据迁移：全部收进 DO 块，按 information_schema 逐一守卫，
-- 无论表当前缺哪些列都不会报错。
-- 背景 1：school_name / campus 是早期把学校和校区分成两列的版本，
--         现已合并为单一 school 列（有校区就连写在一起）。
-- 背景 2：semester_start 是第六步新增列（学期第一周周一日期），
--         旧库没有该列时注释语句安全跳过。
DO $mig$
DECLARE
  has_school       boolean;
  has_school_name  boolean;
  has_campus       boolean;
  has_semester     boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'user_settings'
                   AND column_name = 'school') INTO has_school;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'user_settings'
                   AND column_name = 'school_name') INTO has_school_name;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'user_settings'
                   AND column_name = 'campus') INTO has_campus;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'user_settings'
                   AND column_name = 'semester_start') INTO has_semester;

  -- 列注释：对应列存在才写（缺列时安全跳过，不再触发 42703）
  IF has_school THEN
    EXECUTE $cmd$COMMENT ON COLUMN public.user_settings.school IS '学校名称：有校区则写在一起（如 北京大学昌平校区），高德地理编码按「学校+教学楼/宿舍」拼名精确定位'$cmd$;
  END IF;
  IF has_semester THEN
    EXECUTE $cmd$COMMENT ON COLUMN public.user_settings.semester_start IS '学期第一周的周一日期（YYYY-MM-DD）：当前周数 = floor((今天 - semester_start)/7)+1，用于判断课程起止周次与单双周'$cmd$;
  END IF;

  -- 历史数据迁移：school_name / campus 各自独立判断，按实际存在的列合并进 school
  IF has_school AND has_school_name AND has_campus THEN
    EXECUTE $cmd$UPDATE public.user_settings
                  SET school = concat_ws('', school_name, campus)
                WHERE school IS NULL
                  AND (school_name IS NOT NULL OR campus IS NOT NULL)$cmd$;
  ELSIF has_school AND has_school_name THEN
    EXECUTE $cmd$UPDATE public.user_settings
                  SET school = school_name
                WHERE school IS NULL AND school_name IS NOT NULL$cmd$;
  ELSIF has_school AND has_campus THEN
    EXECUTE $cmd$UPDATE public.user_settings
                  SET school = campus
                WHERE school IS NULL AND campus IS NOT NULL$cmd$;
  END IF;
END
$mig$;

-- 删除已废弃的旧列（不存在则自动跳过）
ALTER TABLE public.user_settings DROP COLUMN IF EXISTS school_name;
ALTER TABLE public.user_settings DROP COLUMN IF EXISTS campus;

COMMENT ON TABLE public.user_settings IS '用户默认设置（按 user_id 绑定登录用户，RLS 隔离）';

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_settings_read_own   ON public.user_settings;
DROP POLICY IF EXISTS user_settings_insert_own ON public.user_settings;
DROP POLICY IF EXISTS user_settings_update_own ON public.user_settings;
DROP POLICY IF EXISTS user_settings_delete_own ON public.user_settings;

CREATE POLICY user_settings_read_own   ON public.user_settings FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY user_settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY user_settings_update_own ON public.user_settings FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY user_settings_delete_own ON public.user_settings FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ---------- 表 2：用户课表 ----------
-- 每行 = 一门课；course_name 课程名、start_time/end_time 起止时间、
-- location 地点、weeks 周数文本（如 '1-16' / '单周' / '1-8,10-16'，保留原始
-- 识别结果）；第六步新增结构化周次字段：
--   start_week 起始周次、end_week 结束周次、week_type 单双周
--   （'all'=每周 / 'odd'=单周 / 'even'=双周）。
-- 前端逻辑以结构化字段为准判断「本周是否有这门课」，文本 weeks 作为
-- 兜底与展示（兼容 "1-8,10-16" 这类不连续周次）。
CREATE TABLE IF NOT EXISTS public.schedule_data (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     UUID        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  course_name TEXT        NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  location    TEXT,
  weeks       TEXT,
  start_week  SMALLINT,             -- 起始周次（如 1）
  end_week    SMALLINT,             -- 结束周次（如 16）
  week_type   TEXT        NOT NULL DEFAULT 'all', -- 单双周：all=每周 / odd=单周 / even=双周
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 旧库补列（可重复执行，已存在则跳过）
ALTER TABLE public.schedule_data ADD COLUMN IF NOT EXISTS start_week SMALLINT;
ALTER TABLE public.schedule_data ADD COLUMN IF NOT EXISTS end_week   SMALLINT;
ALTER TABLE public.schedule_data ADD COLUMN IF NOT EXISTS week_type  TEXT NOT NULL DEFAULT 'all';

CREATE INDEX IF NOT EXISTS schedule_data_user_id_idx ON public.schedule_data(user_id);

-- 历史数据回填：从 weeks 文本反推结构化周次字段（收进 DO 块守卫，幂等）。
--   "1-16"        → start_week=1,  end_week=16, week_type='all'
--   "1-8,10-16"   → start_week=1,  end_week=16（取所有数字的最小/最大值）
--   "单周"/"双周" → week_type='odd'/'even'（无数字则起止周次留空=不限制）
--   "3"           → start_week=3,  end_week=3
DO $wk$
DECLARE
  has_sw    boolean;
  has_ew    boolean;
  has_wt    boolean;
  has_weeks boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schedule_data'
                   AND column_name = 'start_week') INTO has_sw;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schedule_data'
                   AND column_name = 'end_week') INTO has_ew;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schedule_data'
                   AND column_name = 'week_type') INTO has_wt;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schedule_data'
                   AND column_name = 'weeks') INTO has_weeks;

  IF has_sw AND has_ew AND has_wt AND has_weeks THEN
    -- 起止周次：取 weeks 文本中所有数字的最小/最大值（无数字的行不受影响）
    -- ⚠️ regexp_matches(..., 'g') 返回的是 setof text[]（每行一个数组），
    --    必须取数组元素 m.n[1] 再转整数；直接写 m.n::integer 会报 42846。
    EXECUTE $cmd$
      UPDATE public.schedule_data s
         SET start_week = agg.mn::smallint, end_week = agg.mx::smallint
        FROM (
          SELECT sd.id AS id,
                 min(m.n[1]::integer) AS mn,
                 max(m.n[1]::integer) AS mx
            FROM public.schedule_data sd
            CROSS JOIN LATERAL regexp_matches(sd.weeks, '(\d+)', 'g') AS m(n)
           WHERE sd.weeks IS NOT NULL AND sd.weeks <> ''
           GROUP BY sd.id
        ) agg
       WHERE s.id = agg.id
         AND s.start_week IS NULL$cmd$;
    -- 单双周：从 weeks 文本识别（含「单」「双」字样）
    EXECUTE $cmd$UPDATE public.schedule_data
                  SET week_type = 'odd'
                WHERE weeks LIKE '%单%' AND week_type IS DISTINCT FROM 'odd'$cmd$;
    EXECUTE $cmd$UPDATE public.schedule_data
                  SET week_type = 'even'
                WHERE weeks LIKE '%双%' AND weeks NOT LIKE '%单%'
                  AND week_type IS DISTINCT FROM 'even'$cmd$;
    -- 兜底：仍为 NULL 的统一记为每周（理论上 DEFAULT 已覆盖，双保险）
    EXECUTE $cmd$UPDATE public.schedule_data SET week_type = 'all' WHERE week_type IS NULL$cmd$;
  END IF;
END
$wk$;

COMMENT ON TABLE  public.schedule_data IS '用户课表（每行一门课，含结构化周次字段，按 user_id 绑定登录用户，RLS 隔离）';
COMMENT ON COLUMN public.schedule_data.weeks      IS '周数文本（识别原始结果，如 1-16 / 单周 / 1-8,10-16）';
COMMENT ON COLUMN public.schedule_data.start_week IS '起始周次（与 semester_start 一起判断本周是否有课）';
COMMENT ON COLUMN public.schedule_data.end_week   IS '结束周次';
COMMENT ON COLUMN public.schedule_data.week_type  IS '单双周：all=每周 / odd=单周 / even=双周';

ALTER TABLE public.schedule_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedule_data_read_own   ON public.schedule_data;
DROP POLICY IF EXISTS schedule_data_insert_own ON public.schedule_data;
DROP POLICY IF EXISTS schedule_data_update_own ON public.schedule_data;
DROP POLICY IF EXISTS schedule_data_delete_own ON public.schedule_data;

CREATE POLICY schedule_data_read_own   ON public.schedule_data FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY schedule_data_insert_own ON public.schedule_data FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY schedule_data_update_own ON public.schedule_data FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY schedule_data_delete_own ON public.schedule_data FOR DELETE TO authenticated USING (user_id = auth.uid());

-- =====================================================================
-- 校验（可选）：在 SQL Editor 单独运行，确认 RLS 与策略就位
--   select tablename, rowsecurity from pg_tables  where schemaname='public';
--   select tablename, policyname, cmd, roles from pg_policies where schemaname='public' order by tablename, policyname;
-- 预期：两张表 rowsecurity = true；每张表 4 条策略（SELECT/INSERT/UPDATE/DELETE），
--       roles = authenticated，条件均为 user_id = auth.uid()。
-- 提示：前端只用 anon key；service_role key 切勿暴露在前端代码里。
-- =====================================================================
